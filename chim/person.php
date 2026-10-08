<?php
/* person.php — the SkyManager person page's CHIM half (2026-10-03), from the CLI.
 *
 *   php person.php read      "<npc>"                         memories, diary, letters, bonds, life
 *   php person.php bond      "<npc>" aff=<-100..100> [type=<t>] set how she feels about the player
 *   php person.php analyze   "<npc>"                         CHIM's relationship AI re-judges her
 *   php person.php life      "<npc>" enabled=0|1 [letters=0|1]  switch background life / letters
 *   php person.php life_now  "<npc>" kind=letter|action      run one background-life turn now
 *   php person.php household "-" names=<json list> [auto=1]    the dashboard: sync + digest (below)
 *   php person.php judge_bg  "-" names=<json list>          judge several in the background (spawned by household)
 *
 * Prints exactly one line: PERSON_RESULT {json}. Installed next to ask.php
 * (ext/deck_ask/), called by ask.php's person* modes — the same CLI-twin pattern
 * as dynprof.php, so it runs under CHIM's OWN bootstrap and calls CHIM's OWN code:
 *
 *   Bonds     = CHIM's relationship system (lib/relationship_manager.php +
 *               ext/relationship_system/relationship_llm.php). Scores live in
 *               core_npc_master.extended_data.relationships, the tiers are CHIM's,
 *               and the same data is what CHIM injects into every prompt — so a
 *               change made here is a change in how she TALKS to you.
 *   Life Away = CHIM's Background Life (lib/background_life_requests.php): her
 *               off-screen actions, rumours and letters (a letter also reaches the
 *               game as a book by courier, and lands in her diary).
 *   Memories  = CHIM's memory + diarylog tables, dated in Tamrielic time.
 *
 * Nothing here invents a parallel system: every write goes through the function
 * CHIM's own UI uses for the same change.
 */
$engine = realpath(__DIR__ . '/../../') . '/';
$op   = trim((string)($argv[1] ?? ''));
$name = trim((string)($argv[2] ?? ''));
$args = [];
foreach (array_slice($argv, 3) as $a) {
  $eq = strpos($a, '=');
  if ($eq !== false) $args[substr($a, 0, $eq)] = substr($a, $eq + 1);
}
function out($arr) { echo "PERSON_RESULT " . json_encode($arr, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n"; exit(0); }
function fail($why) { out(['ok' => false, 'why' => $why]); }
if ($name === '' && $op !== 'household') fail('no npc name');

require_once $engine . 'lib/chim_interaction.php';
@ob_end_clean();
$GLOBALS['ENGINE_ROOT'] = $engine;
$GLOBALS['ENGINE_PATH'] = $engine;
require_once $engine . 'service/lib/core_utils.php';
require_once $engine . 'lib/runtime_bootstrap.php';
chimRuntimeBootstrap($engine, [
  'load_general_settings' => true,
  'load_stt_connector' => false,
  'load_itt_connector' => false,
  'load_player_name' => true,
  'load_narrator' => true,
]);
if (function_exists('ptr_runtime_ready')) ptr_runtime_ready();
require_once $engine . 'lib/logger.php';
require_once $engine . 'lib/utils_game_timestamp.php';
require_once $engine . 'lib/core/npc_master.class.php';
require_once $engine . 'lib/relationship_manager.php';
require_once $engine . 'lib/background_life_requests.php';
require_once $engine . 'lib/background_life_dashboard.php';
if (!isset($GLOBALS['db'])) $GLOBALS['db'] = new sql();
$db = $GLOBALS['db'];
@ob_end_clean();

set_exception_handler(function ($e) { fail('CHIM said: ' . $e->getMessage()); });
$npcMaster = new NpcMaster();
$player  = (string)($GLOBALS['PLAYER_NAME'] ?? 'Player');
if ($op !== 'household' && $op !== 'judge_bg') {
  $npc = $npcMaster->getByName($name);
  if (!$npc) fail($name . ' has no CHIM profile yet — talk to them once in game, then open this page again');
  $npcName = (string)$npc['npc_name'];
}

function lit($db, $s) { return $db->escapeLiteral($s); }
// Which CHIM connector a feature is set to use, and what is wrong with it.
// CHIM's own scripts crash on an unset slot ("missing or empty 'driver'"), and a
// retired OpenRouter model answers 404, so name the setting instead of a PHP trace.
function connector_problem($db, $slot, $feature) {
  $v = $db->fetchAll("SELECT value FROM general_settings WHERE id = " . lit($db, $slot));
  $id = intval($v[0]['value'] ?? 0);
  if ($id <= 0) return $feature . ' has no AI connector set in CHIM (' . $slot . ' is empty)';
  $c = $db->fetchAll("SELECT label, model FROM core_llm_connector WHERE id = " . $id);
  if (!$c) return $feature . ' points at CHIM connector #' . $id . ', which no longer exists (' . $slot . ')';
  return '';
}
function connector_name($db, $slot) {
  $v = $db->fetchAll("SELECT value FROM general_settings WHERE id = " . lit($db, $slot));
  $c = $db->fetchAll("SELECT label, model FROM core_llm_connector WHERE id = " . intval($v[0]['value'] ?? 0));
  return $c ? ('#' . intval($v[0]['value']) . ' ' . $c[0]['label'] . ' (' . $c[0]['model'] . ')') : '';
}
function tdate($gamets) {
  $g = intval($gamets);
  return $g > 0 ? convert_gamets2skyrim_long_date2($g) : '';
}
// CHIM stores a diary entry's place as its whole prompt context; keep the place.
function place_of($raw) {
  $raw = (string)$raw;
  if (preg_match('/Context location:\s*([^,]+?)\s*,\s*Hold:\s*([^,]+)/i', $raw, $m)) return trim($m[1]) . ', ' . trim($m[2]);
  return strlen($raw) > 80 ? '' : trim($raw);
}
function ext_of($npc) {
  $e = $npc['extended_data'] ?? '{}';
  $d = is_array($e) ? $e : json_decode((string)$e, true);
  return is_array($d) ? $d : [];
}

function bonds_of($npcName, $player) {
  $rels = RelationshipManager::getRelationships($npcName);
  if (!is_array($rels)) $rels = [];
  $pl = null; $others = [];
  foreach ($rels as $target => $r) {
    if (!is_array($r)) continue;
    $aff  = intval($r['aff'] ?? 0);
    $row  = ['name' => (string)$target, 'aff' => $aff, 'tier' => RelationshipManager::getTierLabel($aff),
             'type' => (string)($r['type'] ?? 'neutral')];
    if (!empty($r['note'])) $row['note'] = (string)$r['note'];
    if ($target === 'Player' || $target === $player) $pl = $row; else $others[] = $row;
  }
  usort($others, function ($a, $b) { return abs($b['aff']) <=> abs($a['aff']); });
  return ['player' => $pl, 'others' => array_slice($others, 0, 24),
          'enabled' => !empty($GLOBALS['RELATIONSHIP_SYSTEM_ENABLED']) && $GLOBALS['RELATIONSHIP_SYSTEM_ENABLED'] !== 'false'];
}

/* Judge one NPC from her event history — CHIM's OWN "Build with AI": its
 * ext/relationship_system/analyze_relationships.php reads up to 200 events,
 * asks the relationship model, and RETURNS the map (CHIM's editor then saves
 * it). RelationshipLLM::analyzeNpc is a stub in this CHIM version (always
 * "skipped") — calling it judges nobody. So: run the endpoint in a child
 * process (it exit()s on its own errors), then save exactly the way
 * RelationshipLLM::saveRelationships does — honouring relationships_locked,
 * keeping each target's custom_info — except that a fresh judgement REPLACES an
 * old one per target (a re-judge that could only add new names would never
 * move how she feels about you). */
function judge_npc($engine, $npcMaster, $row) {
  $dir = $engine . 'ext/relationship_system/';
  if (!is_file($dir . 'analyze_relationships.php')) return ['ok' => false, 'why' => 'CHIM relationship system is not installed'];
  $post = var_export(['npc_id' => (string)intval($row['id']), 'npc_name' => (string)$row['npc_name'], 'event_limit' => '200'], true);
  $code = '$_POST = ' . $post . '; $_SERVER["REQUEST_METHOD"] = "POST"; include "analyze_relationships.php";';
  $outp = shell_exec('cd ' . escapeshellarg($dir) . ' && php -r ' . escapeshellarg($code) . ' 2>/dev/null');
  $j = null;
  if (preg_match('/\{"ok".*\}\s*$/s', (string)$outp, $m)) $j = json_decode($m[0], true);
  if (!is_array($j)) return ['ok' => false, 'why' => 'CHIM’s relationship model gave no readable answer'];
  if (empty($j['ok'])) {
    $why = (string)($j['error'] ?? 'CHIM could not judge');
    $cn = connector_name($GLOBALS['db'], 'RELLLM_CONNECTOR');
    if (stripos($why, 'parse') !== false && $cn !== '') $why .= ' — CHIM’s relationship connector ' . $cn . ' returned nothing (a retired model answers 404)';
    return ['ok' => false, 'why' => $why];
  }
  $incoming = is_array($j['relationships'] ?? null) ? $j['relationships'] : [];
  $fresh = $npcMaster->getById(intval($row['id']));
  $ext = ext_of($fresh ?: $row);
  if (!empty($ext['relationships_locked'])) return ['ok' => false, 'why' => $row['npc_name'] . '’s relationships are locked in CHIM (manual edits protected)'];
  $merged = RelationshipManager::normalizeRelationshipMap($ext['relationships'] ?? []);
  foreach (RelationshipManager::normalizeRelationshipMap($incoming) as $target => $rel) {
    $custom = $merged[$target]['custom_info'] ?? '';
    $merged[$target] = $rel;
    if ($custom !== '') $merged[$target]['custom_info'] = $custom;
  }
  $ext['relationships'] = $merged;
  $ext['relationships_analyzed'] = date('Y-m-d H:i:s');
  $ext['relationships_model'] = (string)($j['model'] ?? '');
  $id = intval($row['id']);
  $ok = chimRunWithRelationshipExtendedDataWrite(function () use ($npcMaster, $id, $ext) {
    return $npcMaster->updateByArray(['id' => $id, 'extended_data' => json_encode($ext, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
  });
  if ($ok !== false && function_exists('chimRelationshipTimelineStamp')) chimRelationshipTimelineStamp($id);
  return ['ok' => $ok !== false, 'count' => count($incoming), 'events' => intval($j['event_count'] ?? 0),
          'why' => $ok === false ? 'CHIM refused to save the judgement' : ''];
}

function life_of($db, $npcMaster, $npc) {
  $st = chimBglNpcStatus($npcMaster, $npc, '', (string)$npc['npc_name']);
  $hist = $db->fetchAll("SELECT gamets, data, category FROM bgl_history WHERE npc = " . lit($db, (string)$npc['npc_name']) .
                        " ORDER BY gamets DESC, rowid DESC LIMIT 30");
  $rows = [];
  foreach ($hist ?: [] as $h) {
    $text = trim((string)($h['data'] ?? ''));
    $rows[] = ['date' => tdate($h['gamets'] ?? 0), 'gamets' => intval($h['gamets'] ?? 0),
               'category' => trim((string)($h['category'] ?? '')) ?: chimBglHistoryCategory($text), 'text' => $text];
  }
  $e = ext_of($npc);
  return [
    'enabled'  => chimBglBoolean($e['background_life_enabled'] ?? false),
    'letters'  => chimBglBoolean($e['background_life_letters'] ?? false),
    'commands' => chimBglBoolean($e['background_life_commands'] ?? false),
    'last'     => tdate($e['background_life_last_updated'] ?? 0),
    'every_hours' => intval($GLOBALS['BGL_TRIGGER_HOURS'] ?? 24),
    'status'   => $st,
    'history'  => $rows,
  ];
}

function read_person($db, $npcMaster, $npc, $npcName, $player) {
  $L = lit($db, $npcName);
  $mem = $db->fetchAll("SELECT gamets, message FROM memory WHERE speaker = $L OR listener = $L ORDER BY gamets DESC, rowid DESC LIMIT 30");
  $memories = [];
  foreach ($mem ?: [] as $m) {
    $t = trim((string)($m['message'] ?? ''));
    if ($t === '') continue;
    $memories[] = ['date' => tdate($m['gamets'] ?? 0), 'text' => $t];
  }
  // A diary entry's people list starts with its author.
  $Lp = lit($db, $npcName . '%');
  $dia = $db->fetchAll("SELECT gamets, topic, content, location FROM diarylog WHERE people ILIKE $Lp ORDER BY gamets DESC, rowid DESC LIMIT 30");
  $diary = []; $letters = [];
  foreach ($dia ?: [] as $d) {
    $row = ['date' => tdate($d['gamets'] ?? 0), 'topic' => trim((string)($d['topic'] ?? '')),
            'text' => trim((string)($d['content'] ?? '')), 'where' => place_of($d['location'] ?? '')];
    if (strcasecmp($row['topic'], 'Sent Letter') === 0) $letters[] = $row; else $diary[] = $row;
  }
  return ['ok' => true, 'npc' => $npcName, 'npc_id' => intval($npc['id']), 'player' => $player,
          'memories' => $memories, 'diary' => $diary, 'letters' => $letters,
          'bonds' => bonds_of($npcName, $player), 'life' => life_of($db, $npcMaster, $npc)];
}

/* ---- the household: keep CHIM's systems awake for everyone in it ----------
 * Called with the deck's household roster (wives + the expecting, the Household
 * tab's own answer). DYNAMIC, not a one-shot: every call
 *   · judges anyone CHIM has never judged — CHIM's own Build-with-AI, run in a
 *     DETACHED background process (judge_bg) so nobody waits on an LLM here; at
 *     most one attempt per person per day (conf_opts SKYMANAGER_JUDGE_TRIED).
 *     (CHIM's relationship init queue is no use: its analyzeNpc is a stub.);
 *   · the FIRST time it sees someone (auto=1), switches on her Background Life
 *     and letters — once. The names it has seen live in conf_opts
 *     SKYMANAGER_HOUSEHOLD_SEEN, so a later manual "off" is never overridden;
 *   · lists who has no CHIM profile at all (talk to them once in game).
 * …and returns the digest the Household tab's Today view draws: her letters,
 * off-screen happenings, recent diary, and how each one feels about you. */
if ($op === 'judge_bg') {
  $names = json_decode((string)($args['names'] ?? '[]'), true);
  $done = [];
  foreach (is_array($names) ? array_slice($names, 0, 60) : [] as $n) {
    $row = $npcMaster->getByName((string)$n);
    if (!$row) continue;
    $res = judge_npc($engine, $npcMaster, $row);
    $done[] = ['name' => (string)$n, 'ok' => $res['ok'], 'why' => $res['why'] ?? '', 'events' => $res['events'] ?? 0];
    Logger::info('[SKYMANAGER] judged ' . $n . ': ' . ($res['ok'] ? 'ok (' . ($res['events'] ?? 0) . ' events)' : $res['why']));
  }
  // The last failure is shown on the Today view, so a dead connector is not silent.
  $fails = array_values(array_filter($done, function ($d) { return !$d['ok']; }));
  $last = $fails ? $fails[count($fails) - 1]['why'] : '';
  if ($done) $db->query("INSERT INTO conf_opts (id, value) VALUES ('SKYMANAGER_JUDGE_ERROR', " . lit($db, $last) . ") ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value");
  out(['ok' => true, 'judged' => $done]);
}

if ($op === 'household') {
  $names = json_decode((string)($args['names'] ?? '[]'), true);
  if (!is_array($names)) fail('bad household list');
  $names = array_values(array_unique(array_filter(array_map(function ($n) { return trim((string)$n); }, $names))));
  $names = array_slice($names, 0, 60);
  $auto = ($args['auto'] ?? '1') === '1';
  $seenRow = $db->fetchAll("SELECT value FROM conf_opts WHERE id='SKYMANAGER_HOUSEHOLD_SEEN'");
  $seen = $seenRow ? json_decode((string)$seenRow[0]['value'], true) : [];
  if (!is_array($seen)) $seen = [];
  $triedRow = $db->fetchAll("SELECT value FROM conf_opts WHERE id='SKYMANAGER_JUDGE_TRIED'");
  $tried = $triedRow ? json_decode((string)$triedRow[0]['value'], true) : [];
  if (!is_array($tried)) $tried = [];
  $toJudge = [];
  $people = []; $missing = []; $found = []; $queued = 0; $woke = [];
  foreach ($names as $n) {
    $row = $npcMaster->getByName($n);
    if (!$row) { $missing[] = $n; continue; }
    $nm = (string)$row['npc_name']; $found[] = $nm;
    // getPlayerRelationship() answers a default Neutral 0 for someone CHIM has
    // never judged, so "judged" is whether a stored entry exists at all.
    $rels = RelationshipManager::getRelationships($nm);
    $pl = is_array($rels) ? ($rels['Player'] ?? $rels[$player] ?? null) : null;
    $judged = is_array($pl) && isset($pl['aff']);
    // Never judged: judge her in the BACKGROUND (CHIM's own Build-with-AI,
    // one LLM call each) — at most once a day per person, so a model that
    // fails or an NPC with no history yet is not retried every refresh.
    $q = false;
    if (!$judged && (time() - intval($tried[$nm] ?? 0)) > 86400) { $toJudge[] = $nm; $tried[$nm] = time(); $q = true; $queued++; }
    elseif (!$judged && isset($tried[$nm])) $q = true;
    if ($auto && !in_array($nm, $seen, true)) {
      $e = ext_of($row);
      if (!chimBglBoolean($e['background_life_enabled'] ?? false)) chimBglSetEnabled($npcMaster, $row, true);
      $row = $npcMaster->getByName($nm);
      $e = ext_of($row);
      if (!chimBglBoolean($e['background_life_letters'] ?? false)) chimBglUpdateNpcSetting($npcMaster, $row, 'send_letters', true);
      $row = $npcMaster->getByName($nm);
      $seen[] = $nm; $woke[] = $nm;
    }
    $e = ext_of($row);
    $aff = $judged ? intval($pl['aff']) : null;
    $people[] = ['name' => $nm, 'judged' => $judged, 'queued' => $q, 'aff' => $aff,
                 'tier' => $judged ? RelationshipManager::getTierLabel($aff) : '', 'type' => $judged ? (string)($pl['type'] ?? '') : '',
                 'life' => chimBglBoolean($e['background_life_enabled'] ?? false), 'letters' => chimBglBoolean($e['background_life_letters'] ?? false),
                 'last' => tdate($e['background_life_last_updated'] ?? 0)];
  }
  if ($toJudge) {
    $db->query("INSERT INTO conf_opts (id, value) VALUES ('SKYMANAGER_JUDGE_TRIED', " . lit($db, json_encode($tried, JSON_UNESCAPED_UNICODE)) . ") ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value");
    exec('nohup php ' . escapeshellarg(__FILE__) . ' judge_bg - ' . escapeshellarg('names=' . json_encode($toJudge, JSON_UNESCAPED_UNICODE)) . ' > /dev/null 2>&1 &');
  }
  if ($woke) {
    $val = json_encode(array_values(array_unique($seen)), JSON_UNESCAPED_UNICODE);
    $db->query("INSERT INTO conf_opts (id, value) VALUES ('SKYMANAGER_HOUSEHOLD_SEEN', " . lit($db, $val) . ") ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value");
  }
  $letters = []; $diary = []; $happen = [];
  if ($found) {
    $ors = implode(' OR ', array_map(function ($nm) use ($db) { return 'people ILIKE ' . lit($db, $nm . '%'); }, $found));
    foreach ($db->fetchAll("SELECT gamets, topic, content, people, location FROM diarylog WHERE ($ors) ORDER BY gamets DESC, rowid DESC LIMIT 40") ?: [] as $d) {
      $author = trim(explode(',', (string)$d['people'])[0]);
      $row = ['name' => $author, 'date' => tdate($d['gamets']), 'gamets' => intval($d['gamets']), 'topic' => trim((string)$d['topic']),
              'text' => trim((string)$d['content']), 'where' => place_of($d['location'] ?? '')];
      if (strcasecmp($row['topic'], 'Sent Letter') === 0) { if (count($letters) < 12) $letters[] = $row; }
      elseif (count($diary) < 10) $diary[] = $row;
    }
    $in = implode(',', array_map(function ($nm) use ($db) { return lit($db, $nm); }, $found));
    foreach ($db->fetchAll("SELECT npc, gamets, data, category FROM bgl_history WHERE npc IN ($in) ORDER BY gamets DESC, rowid DESC LIMIT 24") ?: [] as $h) {
      $t = trim((string)$h['data']);
      $happen[] = ['name' => (string)$h['npc'], 'date' => tdate($h['gamets']), 'gamets' => intval($h['gamets']),
                   'category' => trim((string)($h['category'] ?? '')) ?: chimBglHistoryCategory($t), 'text' => $t];
    }
  }
  $nowRow = $db->fetchAll("SELECT max(gamets) AS g FROM eventlog");
  $problems = [];
  $bgl = connector_problem($db, 'CORE_CONNECTOR_BGL', 'Background Life');
  if ($bgl !== '') $problems[] = $bgl . ' — no letters or off-screen days can be written';
  $jr = $db->fetchAll("SELECT value FROM conf_opts WHERE id='SKYMANAGER_JUDGE_ERROR'");
  $jerr = trim((string)($jr[0]['value'] ?? ''));
  if ($jerr !== '') $problems[] = 'Judging how people feel failed: ' . $jerr;
  out(['ok' => true, 'kind' => 'household', 'problems' => $problems, 'player' => $player, 'today' => tdate($nowRow[0]['g'] ?? 0),
       'people' => $people, 'missing' => $missing, 'queued' => $queued, 'woke' => $woke,
       'letters' => $letters, 'diary' => $diary, 'happenings' => $happen,
       'relationships_on' => !empty($GLOBALS['RELATIONSHIP_SYSTEM_ENABLED']) && $GLOBALS['RELATIONSHIP_SYSTEM_ENABLED'] !== 'false',
       'every_hours' => intval($GLOBALS['BGL_TRIGGER_HOURS'] ?? 24)]);
}

if ($op === 'read') out(read_person($db, $npcMaster, $npc, $npcName, $player));

if ($op === 'bond') {
  if (!isset($args['aff']) || !is_numeric($args['aff'])) fail('no affinity given');
  $aff  = max(-100, min(100, intval($args['aff'])));
  $type = isset($args['type']) && $args['type'] !== '' ? RelationshipManager::canonicalizeRelationshipType($args['type']) : null;
  $ok = chimRunWithRelationshipExtendedDataWrite(function () use ($npcName, $aff, $type) {
    return RelationshipManager::setRelationship($npcName, 'Player', $aff, $type);
  });
  $npc = $npcMaster->getByName($npcName);
  $r = read_person($db, $npcMaster, $npc, $npcName, $player);
  $r['message'] = $ok === false ? 'CHIM refused the change' : ($npcName . ' now feels ' . RelationshipManager::getTierLabel($aff) . ' toward ' . $player . ' (' . $aff . ')');
  out($r);
}

if ($op === 'analyze') {
  $before = bonds_of($npcName, $player);
  $res = judge_npc($engine, $npcMaster, $npc);
  $npc = $npcMaster->getByName($npcName);
  $r = read_person($db, $npcMaster, $npc, $npcName, $player);
  $b = $before['player']['aff'] ?? null; $a = $r['bonds']['player']['aff'] ?? null;
  $r['message'] = !$res['ok'] ? ('CHIM could not judge ' . $npcName . ': ' . $res['why'])
    : ($a === null ? 'CHIM judged ' . $npcName . ' from ' . $res['events'] . ' events but found nothing between you yet'
      : ($b === $a ? $npcName . '’s feelings stand: ' . $r['bonds']['player']['tier'] . ' (' . $a . ')'
                   : $npcName . ' re-judged from ' . $res['events'] . ' events: ' . ($b === null ? 'unset' : $b) . ' → ' . $a . ' (' . $r['bonds']['player']['tier'] . ')'));
  out($r);
}

if ($op === 'life') {
  if (isset($args['enabled'])) chimBglSetEnabled($npcMaster, $npc, $args['enabled'] === '1');
  $npc = $npcMaster->getByName($npcName);
  if (isset($args['letters'])) chimBglUpdateNpcSetting($npcMaster, $npc, 'send_letters', $args['letters'] === '1');
  $npc = $npcMaster->getByName($npcName);
  $r = read_person($db, $npcMaster, $npc, $npcName, $player);
  $r['message'] = $npcName . ': background life ' . ($r['life']['enabled'] ? 'on' : 'off') . ', letters ' . ($r['life']['letters'] ? 'on' : 'off');
  out($r);
}

if ($op === 'life_now') {
  $kind = ($args['kind'] ?? 'action') === 'letter' ? 'letter' : 'action';
  $e = ext_of($npc);
  if (!chimBglBoolean($e['background_life_enabled'] ?? false)) fail('switch on ' . $npcName . '’s background life first');
  if ($kind === 'letter' && !chimBglBoolean($e['background_life_letters'] ?? false)) fail('switch on letters for ' . $npcName . ' first');
  $bad = connector_problem($db, 'CORE_CONNECTOR_BGL', 'Background Life');
  if ($bad !== '') fail($bad);
  $res = chimBglRunRequest($engine, $npc, $kind);
  $errText = (string)($res['stderr'] ?? '');
  if (preg_match('/Fatal error:\s*(?:Uncaught \w+:\s*)?([^\n]+?)(?: in \/|\n|$)/', $errText, $fm)) $errText = $fm[1];
  $npc = $npcMaster->getByName($npcName);
  $r = read_person($db, $npcMaster, $npc, $npcName, $player);
  $r['message'] = intval($res['exit_code'] ?? 1) === 0
    ? ($kind === 'letter' ? $npcName . ' is writing to you — it arrives by courier in game' : $npcName . ' took an off-screen turn')
    : ('CHIM background life failed: ' . trim(substr($errText, 0, 240)));
  out($r);
}

fail('unknown op ' . $op);
