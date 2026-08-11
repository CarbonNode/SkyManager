<?php
/**
 * deck_ask.php — the Hotkey Deck's "Ask" endpoint (in-game NPC Q&A).
 *
 * Deployed to: /var/www/html/HerikaServer/ext/deck_ask/ask.php  (WSL DwemerAI4Skyrim3)
 * Called by:   the deck's C++ HTTP pipe (src/sharmat.cpp ask channel) — same base-URL
 *              discovery as the Sharmat panel, path /HerikaServer/ext/deck_ask/ask.php
 * Repo copy:   modding/hotkey-deck/chim/deck_ask.php  (source of truth — CHIM updates
 *              wipe ext/? No: ext/ survives updates like aiagent_nsfw does, but keep
 *              this copy authoritative and log the install in chim_modifications.md)
 *
 * Request (GET or POST):
 *   q    = the question ("what is Lydia's personality?")
 *   npc  = optional explicit NPC name — used when q names nobody ("what's her
 *          personality" follow-ups: the view passes the last matched NPC here)
 *   mode = structured (default) | llm
 *
 * structured: resolve the NPC, return every facet we hold on her, plus a `focus`
 *             list saying which facet(s) the question is about. No LLM, instant.
 * llm:        same retrieval, then one chat-completion over the retrieved context
 *             through CHIM's own configured OpenRouter key. A few seconds.
 *
 * Answers are drawn ONLY from the CHIM DB (core_npc_master, nsfw_npc_data,
 * diarylog, speech). Adding a new facet = one entry in $FACETS + one retrieval
 * line — the deck view renders whatever facets arrive, so it scales without a
 * DLL or view change.
 */

header('Content-Type: application/json; charset=utf-8');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_WARNING & ~E_NOTICE);

const DSN = 'host=localhost port=5432 dbname=dwemer user=dwemer password=dwemer';

function db() {
  static $c = null;
  if ($c === null) { $c = @pg_connect(DSN); }
  return $c;
}

function reply($arr) { echo json_encode($arr, JSON_UNESCAPED_UNICODE); exit; }
function bad($msg)   { reply(['ok' => false, 'error' => $msg]); }

function q1($sql, $params = []) {
  $r = @pg_query_params(db(), $sql, $params);
  if (!$r) return null;
  $row = pg_fetch_assoc($r);
  return $row ?: null;
}
function qa($sql, $params = []) {
  $r = @pg_query_params(db(), $sql, $params);
  if (!$r) return [];
  return pg_fetch_all($r) ?: [];
}

// ---------------------------------------------------------------- input ----
$question = trim((string)($_REQUEST['q'] ?? ''));
$explicit = trim((string)($_REQUEST['npc'] ?? ''));
$mode     = ($_REQUEST['mode'] ?? 'structured') === 'llm' ? 'llm' : 'structured';

if ($question === '' && $explicit === '') bad('empty question');

// ------------------------------------------------------------ Direct mode ----
// Not a question — a DIRECTION. The overlay's ⚡ Direct chip routes the text
// into CHIM's director pipe verbatim (the same rolemaster instruction channel
// used from the CLI): nearby NPCs act on it. Fire-and-report; no DB needed.
if (($_REQUEST['mode'] ?? '') === 'direct') {
  $outp = shell_exec('php /var/www/html/HerikaServer/service/manager.php rolemaster instruction '
    . escapeshellarg($question) . ' notify 2>&1');
  reply([
    'ok'      => true,
    'kind'    => 'direct',
    'title'   => 'Direction sent',
    'message' => $question,
    'note'    => 'Nearby NPCs act on this — it lands in the running game (or queues for the next scene).',
    'output'  => mb_substr(trim((string)$outp), 0, 400),
  ]);
}

if (!db()) bad('CHIM database unreachable');

$qlower_early = mb_strtolower($question);

// ------------------------------------------------------------ chronicle ----
// The CANON — pregnancies, story acts, finances, the household — lives in the
// repo's tracker docs, which CHIM never saw. build_chronicle.py compiles them
// into chronicle.json beside this file; score its chunks against the question
// (and the resolved NPC) and the tracker answers what the game data can't.
const CHRON_STOP = ['what','does','about','have','much','many','this','that','with','from',
                    'your','mine','they','them','their','were','when','where','will','would',
                    'should','could','tell','know','like','been','being','also','some'];
// PHP port of build_chronicle.py's chunker — split a doc by markdown headings
// into {source, heading (trail), text} chunks. Kept in lockstep with the
// python: if you change one, change both.
function chronicle_chunks($source, $text) {
  $out = [];
  $trail = [];
  $body = [];
  $headAt = null;
  $flush = function () use (&$body, &$trail, &$headAt, $source, &$out) {
    $joined = trim(preg_replace('/\s+/u', ' ', implode(' ', $body)));
    $body = [];
    if (mb_strlen($joined) < 40) return;
    $parts = [];
    $keys = array_keys($trail);
    sort($keys);
    foreach ($keys as $k) if ($k <= ($headAt ?? 9)) $parts[] = $trail[$k];
    $out[] = ['source' => $source, 'heading' => $parts ? implode(' › ', $parts) : $source,
              'text' => mb_substr($joined, 0, 900)];
  };
  foreach (preg_split('/\r?\n/', $text) as $ln) {
    if (preg_match('/^(#{1,4})\s+(.*)$/u', $ln, $m)) {
      $flush();
      $level = strlen($m[1]);
      $headAt = $level;
      $trail[$level] = trim($m[2]);
      foreach (array_keys($trail) as $k) if ($k > $level) unset($trail[$k]);
    } else {
      $t = trim($ln);
      $t = preg_replace('/^[-*]\s+/u', '', $t);
      $t = str_replace('**', '', $t);
      if ($t !== '') $body[] = $t;
    }
  }
  $flush();
  return $out;
}

// The chronicle stays FRESH on its own: WSL sees the rig checkout at /mnt/c,
// so when the tracker docs there are newer than the cached chronicle.json we
// regenerate it in place. The committed chronicle.json (deployed beside this
// file) is the seed AND the fallback — a missing/stale checkout costs nothing.
// Regeneration only happens when ALL four docs are readable, so a half-synced
// checkout can never shrink the chronicle.
function chronicle_load() {
  $cacheFile = __DIR__ . '/chronicle.json';

  // OPTIONAL, and OFF unless you turn it on. The chronicle lets Ask answer
  // from your own written notes — a campaign journal, a character sheet, a
  // wiki export — for things the game's own data cannot know. Point
  // DECK_ASK_DOCS at a folder of markdown and it is used; leave it unset and
  // the whole feature is simply skipped, which is the default.
  //
  // (It used to be one author's hardcoded Windows path, which meant the
  // feature was dead for everyone else and told them nothing about why.)
  $docsDir = getenv('DECK_ASK_DOCS');
  if (!$docsDir || !is_dir($docsDir)) {
    return is_file($cacheFile) ? (json_decode(@file_get_contents($cacheFile), true) ?: []) : [];
  }
  $docs = ['pregnancy' => 'pregnancy_tracker.md', 'story' => 'story_timeline.md',
           'finances' => 'finances.md', 'household' => 'character_sheet.md'];
  $cacheM = is_file($cacheFile) ? (int)filemtime($cacheFile) : 0;
  $paths = [];
  $newest = 0;
  foreach ($docs as $src => $f) {
    $p = $docsDir . '/' . $f;
    if (!is_readable($p)) { $paths = []; break; }   // all-or-nothing
    $paths[$src] = $p;
    $newest = max($newest, (int)filemtime($p));
  }
  if ($paths && $newest > $cacheM) {
    $chunks = [];
    foreach ($paths as $src => $p) {
      $chunks = array_merge($chunks, chronicle_chunks($src, (string)file_get_contents($p)));
    }
    if (count($chunks) >= 20) {   // sanity floor — never cache a gutted set
      @file_put_contents($cacheFile, json_encode($chunks, JSON_UNESCAPED_UNICODE));
      return $chunks;
    }
  }
  return is_file($cacheFile) ? (json_decode(file_get_contents($cacheFile), true) ?: []) : [];
}

function chronicle_hits($qtokens, $name = '', $limit = 3) {
  static $chron = null;
  if ($chron === null) $chron = chronicle_load();
  $toks = array_values(array_filter($qtokens,
    fn($t) => mb_strlen($t) >= 4 && !in_array($t, CHRON_STOP, true)));
  if (!$toks && $name === '') return [];
  $hits = [];
  foreach ($chron as $c) {
    $head = mb_strtolower($c['heading'] ?? '');
    $body = mb_strtolower($c['text'] ?? '');
    $s = 0;
    foreach ($toks as $t) {
      if (strpos($head, $t) !== false) $s += 2;        // heading hits weigh double
      elseif (strpos($body, $t) !== false) $s += 1;
    }
    if ($name !== '') {
      $nl = mb_strtolower($name);
      $first = explode(' ', $nl)[0];
      if (strpos($head, $nl) !== false || strpos($head, $first) !== false) $s += 3;
      elseif (strpos($body, $first) !== false) $s += 1;
    }
    if ($s >= 2) $hits[] = [$s, $c];
  }
  usort($hits, fn($a, $b) => $b[0] <=> $a[0]);
  return array_map(fn($h) => ['d' => $h[1]['source'] . ' › ' . $h[1]['heading'],
                              'text' => $h[1]['text']],
                   array_slice($hits, 0, $limit));
}

// --------------------------------------------------- "who mentioned X?" ----
// Content search across ALL speech + diaries, no name needed. Checked before
// NPC resolution on purpose: "who mentioned Mjoll" must search FOR Mjoll, not
// resolve her as the subject.
if (preg_match('/\b(?:who\s+(?:said|mentioned|talked\s+about|spoke\s+(?:of|about))|did\s+anyone\s+(?:say|mention|talk\s+about))\s+(.{3,60})$/u',
               rtrim($qlower_early, " ?!."), $mm)) {
  $topic = trim(preg_replace('/^(the|a|an|about|of)\s+/u', '', trim($mm[1])));
  if (mb_strlen($topic) >= 3) {
    $mentions = [];
    foreach (qa("SELECT to_timestamp(localts)::date AS d, speaker, listener, LEFT(speech, 260) AS text
                 FROM speech WHERE speech ILIKE $1 ORDER BY localts DESC LIMIT 8", ['%' . $topic . '%']) as $r) {
      $mentions[] = ['d' => $r['d'], 'text' => $r['speaker'] . ' → ' . $r['listener'] . ': ' . $r['text']];
    }
    foreach (qa("SELECT to_timestamp(localts)::date AS d, people, LEFT(content, 260) AS text
                 FROM diarylog WHERE content ILIKE $1 ORDER BY localts DESC LIMIT 4", ['%' . $topic . '%']) as $r) {
      $mentions[] = ['d' => $r['d'], 'text' => '[diary' . ($r['people'] ? ': ' . $r['people'] : '') . '] ' . $r['text']];
    }
    $out = ['ok' => true, 'kind' => 'world',
            'title' => 'Mentions of “' . $topic . '”' . ($mentions ? '' : ' — nothing recorded'),
            'focus' => ['mentions'],
            'facets' => ['mentions' => $mentions]];
    if ($mode !== 'llm' || !$mentions) reply($out);
    $ctx = '';
    foreach ($mentions as $e) $ctx .= "{$e['d']} {$e['text']}\n";
    llm_answer($out, $ctx, $question);
  }
}

// ------------------------------------------------- aggregate questions ----
// "who are my wives" / "which of my girls are slaves" / "how many are
// pregnant" — ROSTER questions, answered before any single-NPC resolution.
// Trigger = a list cue (who/which/how many/list/all/name/show) AND a class
// word. "Is Jenassa a mercenary?" has the class word but no list cue, so it stays
// a single-NPC question. Adding a class = one entry here; the view renders
// whatever people-list arrives.
// Who the player IS, according to CHIM. Skyrim writes the character name into
// CHIM's own config on every session, so we ask rather than assume; if it is
// not there we match any spouse rather than none, because a question that
// silently returns nothing reads as "you have no wives" instead of "I could
// not tell who you are".
function player_name_like() {
  static $like = null;
  if ($like !== null) return $like;
  $name = '';
  foreach (['PLAYER_NAME', 'HERIKA_PLAYER_NAME', 'DECK_ASK_PLAYER'] as $env) {
    $v = getenv($env);
    if ($v) { $name = trim($v); break; }
  }
  if ($name === '') {
    $row = @q1("SELECT value FROM conf WHERE key IN ('player_name','PLAYER_NAME') LIMIT 1");
    if ($row && !empty($row['value'])) $name = trim($row['value']);
  }
  if ($name === '') { $like = "'%'"; return $like; }
  $like = "'%" . str_replace("'", "''", $name) . "%'";
  return $like;
}

$AGGREGATES = [
  'wives'      => ['words' => ['wives', 'wife', 'married'],
                   'title' => 'Your wives',
                   // The player's own name comes from CHIM at request time
                   // (player_name_sql() below). It used to be one author's
                   // character hardcoded here, which meant this question
                   // returned nothing at all for every other player.
                   'where' => "extended_data->>'spousal_status'='married' AND extended_data->>'spouse_names' ILIKE " . player_name_like()],
  'slaves'     => ['words' => ['slave', 'slaves', 'thrall', 'thralls'],
                   'title' => 'Your slaves & thralls',
                   'where' => "(extended_data->>'is_slave')='true'"],
  'workers'    => ['words' => ['prostitute', 'prostitutes', 'whore', 'whores', 'brothel', 'sex worker', 'sex workers', 'courtesan', 'courtesans', 'girls work'],
                   'title' => 'Brothel workers',
                   'where' => "(extended_data->>'is_prostitute')='true'"],
  'pregnant'   => ['words' => ['pregnant', 'expecting', 'with child', 'carrying'],
                   'title' => 'Currently pregnant',
                   'where' => "(extended_data->>'fertility_is_pregnant')='true'"],
  'uninhibited'=> ['words' => ['slut', 'sluts', 'uninhibited'],
                   'title' => 'Uninhibited',
                   'where' => "(extended_data->>'is_slut')='true'"],
];
$listCue = preg_match('/\b(who|which|how many|list|all of|name my|show|every)\b/', $qlower_early);
if ($listCue) {
  foreach ($AGGREGATES as $aggKey => $agg) {
    $hit = false;
    foreach ($agg['words'] as $w) if (strpos($qlower_early, $w) !== false) { $hit = true; break; }
    if (!$hit) continue;
    $rows = qa("SELECT npc_name,
                       extended_data->>'race' AS race,
                       extended_data->>'spousal_status' AS spousal,
                       (extended_data->>'is_slave')='true' AS slave,
                       (extended_data->>'is_prostitute')='true' AS worker,
                       (extended_data->>'fertility_is_pregnant')='true' AS pregnant,
                       extended_data->>'fertility_father' AS father,
                       extended_data->>'prostitute_type' AS ptype
                FROM nsfw_npc_data WHERE {$agg['where']} ORDER BY npc_name");
    $people = [];
    foreach ($rows as $r) {
      $bits = [];
      if ($r['race']) $bits[] = $r['race'];
      if ($r['spousal'] === 'married') $bits[] = 'wife';
      if ($r['slave'] === 't' || $r['slave'] === true) $bits[] = 'slave';
      if ($r['worker'] === 't' || $r['worker'] === true) $bits[] = ($r['ptype'] ?: 'sex worker');
      if ($r['pregnant'] === 't' || $r['pregnant'] === true)
        $bits[] = 'pregnant' . ($r['father'] ? ' (father: ' . $r['father'] . ')' : '');
      $people[] = ['name' => $r['npc_name'], 'detail' => implode(' · ', $bits)];
    }
    // The pregnancy roster is where game data and canon diverge hardest (the
    // fertility flag is game-side; the tracker doc is the truth) — merge the
    // chronicle's Active Pregnancies in, labelled, deduped by first name.
    if ($aggKey === 'pregnant') {
      $have = array_map(fn($p2) => mb_strtolower(explode(' ', $p2['name'])[0]), $people);
      foreach (chronicle_hits(['pregnancies', 'pregnancy'], '', 12) as $c) {
        if (strpos($c['d'], 'Active Pregnancies ›') === false) continue;
        $nm = trim(mb_substr($c['d'], mb_strrpos($c['d'], '›') + 1));
        if ($nm === '' || in_array(mb_strtolower(explode(' ', $nm)[0]), $have, true)) continue;
        $have[] = mb_strtolower(explode(' ', $nm)[0]);
        $people[] = ['name' => $nm, 'detail' => mb_substr($c['text'], 0, 90) . ' · chronicle'];
      }
    }
    $out = ['ok' => true, 'kind' => 'aggregate',
            'title' => $agg['title'] . ' (' . count($people) . ')',
            'people' => $people];
    if ($mode !== 'llm' || !$people) reply($out);
    // LLM over the roster — "how many of my wives are also slaves" etc.
    $ctx = $agg['title'] . ":\n";
    foreach ($people as $p2) $ctx .= '- ' . $p2['name'] . ($p2['detail'] ? ' (' . $p2['detail'] . ')' : '') . "\n";
    llm_answer($out, $ctx, $question);
  }
}

// ------------------------------------------------------------ the roster ----
// Every name the DB knows an NPC by: core_npc_master is the registry;
// nsfw_npc_data can hold names core doesn't (auto-generated profiles).
$roster = [];
foreach (qa('SELECT id, npc_name FROM core_npc_master WHERE npc_name IS NOT NULL') as $r) {
  $roster[$r['npc_name']] = ['core_id' => (int)$r['id'], 'name' => $r['npc_name']];
}
foreach (qa('SELECT npc_name FROM nsfw_npc_data WHERE npc_name IS NOT NULL') as $r) {
  if (!isset($roster[$r['npc_name']])) $roster[$r['npc_name']] = ['core_id' => 0, 'name' => $r['npc_name']];
}
if (!$roster) bad('no NPCs registered in CHIM yet');

// ------------------------------------------------------- resolve the NPC ----
// Score every roster name against the question's tokens. A question token that
// IS a name word wins big; a prefix of one scores less; the full name appearing
// as a substring of the question outranks both. Ties surface as `candidates`.
function name_score($name, $qtokens, $qlower) {
  $score = 0.0;
  $nlower = mb_strtolower($name);
  // "Full name typed" bonus only for MULTI-word names: a single-word name is
  // always its own full name, so this bonus would let "…with Jenassa" outrank
  // the actual subject "Mjoll" (whose surname the asker never types).
  // Single-word names still score the per-word exact match below.
  if ($nlower !== '' && mb_strpos($nlower, ' ') !== false && strpos($qlower, $nlower) !== false)
    $score += 10.0;
  $words = 0; $matched = 0;
  foreach (preg_split('/[\s\'\-]+/u', $nlower) as $w) {
    if ($w === '') continue;
    $words++;                       // EVERY word counts toward coverage —
    if (mb_strlen($w) < 3) continue; // "Mjoll's Housecarl" must dilute to 1/3,
    $hitThis = false;                // not tie "Mjoll the Lioness" at 1/2
    foreach ($qtokens as $t) {
      if ($t === $w) { $score += 5.0; $hitThis = true; continue; }
      if (mb_strlen($t) >= 4 && strpos($w, $t) === 0) { $score += 2.0; $hitThis = true; }  // "jenas" -> Jenassa
      if (mb_strlen($t) >= 4 && strpos($t, $w) === 0) { $score += 1.0; $hitThis = true; }  // "jenassas" -> Jenassa
    }
    if ($hitThis) $matched++;
  }
  // Coverage bonus, SMALL on purpose: "Mjoll" must mean Mjoll the Lioness
  // (1 of 2 words hit), not Mjoll's Housecarl (1 of 3) — but at 2.0 this
  // out-muscled the subject-position bonus and handed "what did Mjoll say
  // about Jenassa" to Jenassa (a 1/1 name). Coverage breaks ties between
  // otherwise-equal candidates; position decides who the question is ABOUT.
  if ($words > 0 && $matched > 0) $score += 0.5 * $matched / $words;
  return $score;
}

$qlower  = mb_strtolower($question);
$qtokens = array_values(array_filter(
  preg_split('/[^\p{L}\p{N}]+/u', $qlower),
  fn($t) => mb_strlen($t) >= 3
));

$best = null; $bestScore = 0.0; $scores = [];
foreach ($roster as $info) {
  $s = name_score($info['name'], $qtokens, $qlower);
  if ($s <= 0) continue;
  // Subject-position tiebreak: "would Mjoll be jealous of Jenassa" is a
  // question ABOUT Mjoll — the EARLIER mention is the subject, so a name
  // appearing sooner in the question gets a small bonus that breaks ties
  // without ever outranking a stronger match kind.
  $pos = mb_strpos($qlower, mb_strtolower(mb_substr($info['name'], 0, 4)));
  if ($pos !== false) $s += 3.0 / (1.0 + $pos / 10.0);
  $scores[$info['name']] = $s;
  if ($s > $bestScore) { $bestScore = $s; $best = $info; }
}
arsort($scores);

// Explicit npc= (follow-up questions: "what's her personality") wins when the
// question itself names nobody — but a NAMED person in the question outranks it,
// so "and what about Hulda?" moves on even with npc=Lydia attached.
if ($best === null && $explicit !== '') {
  foreach ($roster as $info) {
    if (mb_strtolower($info['name']) === mb_strtolower($explicit) ||
        stripos($info['name'], $explicit) !== false) { $best = $info; $bestScore = 1; break; }
  }
}
if ($best === null) {
  // ------------------------------------------------- world recap branch ----
  // No NPC named and none carried over: "what happened lately?", "who died?",
  // "any news?" — answer about the WORLD from the narrative memory summaries,
  // the diary, and the event log, instead of erroring.
  if (preg_match('/\b(happen|happened|happening|going on|recently|lately|news|recap|died|deaths|last (night|session)|today)\b/', $qlower)) {
    $events = [];
    foreach (qa("SELECT summary FROM memory_summary
                 WHERE summary IS NOT NULL AND summary <> ''
                 ORDER BY gamets_truncated DESC LIMIT 3") as $r) {
      // shape: "#Summary:\n<in-world date>\n\n<prose>"
      $lines = preg_split('/\n/', trim($r['summary']));
      $d = ''; $body = [];
      foreach ($lines as $ln) {
        $ln = trim($ln);
        if ($ln === '' || $ln === '#Summary:') continue;
        if ($d === '' && preg_match('/4E\s*20\d/', $ln)) { $d = $ln; continue; }
        $body[] = $ln;
      }
      $events[] = ['d' => $d, 'text' => mb_substr(implode(' ', $body), 0, 500)];
    }
    $deaths = [];
    foreach (qa("SELECT data, location, to_timestamp(localts)::date AS d
                 FROM eventlog WHERE type='death' ORDER BY localts DESC LIMIT 8") as $r) {
      $who = preg_match('/\)\s*([^()]*?)\s+died/', $r['data'], $m) ? trim($m[1]) : mb_substr($r['data'], 0, 60);
      $deaths[] = ['d' => $r['d'], 'text' => $who . ' died' . ($r['location'] ? ' — ' . $r['location'] : '')];
    }
    $wdiary = [];
    foreach (qa("SELECT to_timestamp(localts)::date AS d, people, LEFT(content, 400) AS text
                 FROM diarylog ORDER BY localts DESC LIMIT 4") as $r) {
      $wdiary[] = ['d' => $r['d'], 'text' => ($r['people'] ? '[' . $r['people'] . '] ' : '') . $r['text']];
    }
    $focus = ['events'];
    if (preg_match('/\b(died|deaths)\b/', $qlower)) $focus = ['deaths'];
    $out = ['ok' => true, 'kind' => 'world', 'title' => 'Lately, in the world',
            'focus' => $focus,
            'facets' => ['events' => $events, 'deaths' => $deaths, 'diary' => $wdiary]];
    if ($mode !== 'llm') reply($out);
    $ctx = '';
    foreach ($events as $e) $ctx .= "SCENE {$e['d']}: {$e['text']}\n";
    foreach ($deaths as $e) $ctx .= "DEATH {$e['d']}: {$e['text']}\n";
    foreach ($wdiary as $e) $ctx .= "DIARY {$e['d']}: {$e['text']}\n";
    llm_answer($out, $ctx, $question);
  }
  // Last resort before erroring: the chronicle. "what's act 4 about?",
  // "how much do my properties earn?" name nobody and aren't a recap —
  // but the tracker docs know.
  $chron = chronicle_hits($qtokens, '', 3);
  if ($chron) {
    $out = ['ok' => true, 'kind' => 'world', 'title' => 'From the chronicle',
            'focus' => ['chronicle'], 'facets' => ['chronicle' => $chron]];
    if ($mode !== 'llm') reply($out);
    $ctx = '';
    foreach ($chron as $e) $ctx .= "CHRONICLE {$e['d']}: {$e['text']}\n";
    llm_answer($out, $ctx, $question);
  }
  reply(['ok' => false, 'error' => 'no NPC recognized in the question',
         'hint' => 'name someone — "what is Lydia\'s sexual preference?" — or ask the world: "what happened lately?"',
         'roster_size' => count($roster)]);
}
$candidates = array_slice(array_keys($scores), 0, 5);

// ------------------------------------------------------------- retrieval ----
$name = $best['name'];

$core = $best['core_id']
  ? q1('SELECT id, npc_name, race, gender, occupation, npc_static_bio, personality,
               relationships, goals, appearance, skills, speechstyle, prompt_head,
               dynamic_profile, lock_profile
        FROM core_npc_master WHERE id=$1', [$best['core_id']])
  : null;

$nsfwRow = q1('SELECT extended_data, updated_at FROM nsfw_npc_data WHERE npc_name=$1', [$name]);
$nsfw = $nsfwRow ? json_decode($nsfwRow['extended_data'], true) : null;

// Latest diary entries mentioning her (diarylog.people is a name list column).
$diary = qa("SELECT to_timestamp(localts)::date AS d, LEFT(content, 600) AS text
             FROM diarylog WHERE people ILIKE $1 ORDER BY localts DESC LIMIT 4", ['%' . $name . '%']);

// Her most recent lines (and lines to her) — tone evidence, not transcript dump.
// "what did she SAY ABOUT <someone/something>?" narrows to lines mentioning it:
// the topic = the longest other roster-name or quoted phrase in the question.
$sayTopic = '';
if (preg_match('/\b(say|said|says|talk|talked|mention|mentioned|think|thinks|thinks of|opinion)\b/', $qlower)) {
  foreach ($roster as $info) {
    if ($info['name'] === $name) continue;
    if (name_score($info['name'], $qtokens, $qlower) >= 5 && mb_strlen($info['name']) > mb_strlen($sayTopic))
      $sayTopic = $info['name'];
  }
}
$speechNote = '';
if ($sayTopic !== '') {
  $speech = qa("SELECT to_timestamp(localts)::date AS d, speaker, listener, LEFT(speech, 300) AS text
                FROM speech WHERE speaker=$1 AND speech ILIKE $2 ORDER BY localts DESC LIMIT 8",
               [$name, '%' . $sayTopic . '%']);
  if ($speech) {
    $speechNote = 'her lines mentioning ' . $sayTopic;
  } else {
    // honest fallback: say so, then show her ordinary recent lines
    $speechNote = 'no recorded lines mentioning ' . $sayTopic . ' — recent lines instead';
    $sayTopic = '';
  }
}
if ($sayTopic === '') {
  $speech = qa("SELECT to_timestamp(localts)::date AS d, speaker, listener, LEFT(speech, 240) AS text
                FROM speech WHERE speaker=$1 OR listener=$1 ORDER BY localts DESC LIMIT 6", [$name]);
}

// Her stored memories — key moments CHIM wrote down ("the player met X for the
// first time on…", oaths, turning points). memory.speaker/listener are names.
$memories = qa("SELECT to_timestamp(localts)::date AS d, LEFT(message, 350) AS text
                FROM memory WHERE speaker=$1 OR listener=$1 ORDER BY localts DESC LIMIT 5", [$name]);

// ------------------------------------------------------- facet detection ----
// Keyword table — question words → which facet the asker is after. Adding a
// facet here (and to $facets below) is the WHOLE change; the view renders
// whatever arrives. Unmatched questions focus 'bio' + 'personality'.
$FACETS = [
  'intimacy'      => ['sexual','sex','kink','kinks','orientation','preference','preferences','intimacy',
                      'intimate','bed','fetish','fetishes','attracted','attraction','turn','turns','slut',
                      'prostitute','whore','price','pricing','cost','rates','services'],
  'personality'   => ['personality','character','like','temperament','nature','behave','behaves',
                      'attitude','mood','moods','traits'],
  'relationships' => ['relationship','relationships','married','marriage','spouse','husband','wife',
                      'wives','lover','friends','friend','family','feel','feels','feelings','love',
                      'loves','hate','hates','jealous','loyal','loyalty','bond'],
  'goals'         => ['goal','goals','want','wants','ambition','ambitions','plan','plans','dream','dreams'],
  'bio'           => ['who','background','backstory','history','story','from','born','past','bio'],
  'appearance'    => ['look','looks','appearance','wear','wears','hair','eyes','body','beautiful','pretty'],
  'skills'        => ['skill','skills','fight','fights','magic','good at','abilities','combat'],
  'diary'         => ['diary','lately','recently','recent','doing','been up','news','happened'],
  'occupation'    => ['occupation','job','work','works','trade','profession','do for'],
  'pregnancy'     => ['pregnant','pregnancy','baby','child','father','due','expecting','carrying','heir'],
  'memories'      => ['remember','remembers','memory','memories','met','meet','first time','first met','first meet','history','how long'],
  'speech'        => ['say','said','says','talk','talked','mention','mentioned','opinion','think','thinks'],
];
$focus = [];
foreach ($FACETS as $facet => $words) {
  foreach ($words as $w) {
    if (strpos($qlower, $w) !== false) { $focus[] = $facet; break; }
  }
}
if (!$focus) $focus = ['bio', 'personality'];

// --------------------------------------------------------- response body ----
$facets = [];
if ($core) {
  foreach (['occupation','npc_static_bio','personality','relationships','goals',
            'appearance','skills','speechstyle'] as $col) {
    if (!empty($core[$col])) {
      $key = $col === 'npc_static_bio' ? 'bio' : $col;
      $facets[$key] = $core[$col];
    }
  }
}
if (is_array($nsfw)) {
  $facets['intimacy'] = [
    'orientation'      => $nsfw['sexual_orientation']      ?? null,
    'preference'       => $nsfw['relationship_preference'] ?? null,
    'spousal_status'   => $nsfw['spousal_status']          ?? null,
    'spouse_names'     => $nsfw['spouse_names']            ?? null,
    'kinks'            => $nsfw['nsfw_kinks']              ?? ($nsfw['kinks'] ?? []),
    'secret_kinks'     => $nsfw['nsfw_secret_kinks']       ?? ($nsfw['secret_kinks'] ?? []),
    'is_slave'         => !empty($nsfw['is_slave']),
    'is_prostitute'    => !empty($nsfw['is_prostitute']),
    'is_slut'          => !empty($nsfw['is_slut']),
    'profanity_level'  => $nsfw['profanity_level']         ?? null,
    'speak_style'      => $nsfw['sex_speech_style']        ?? ($nsfw['speak_style'] ?? null),
    'sex_prompt'       => isset($nsfw['sex_prompt']) ? mb_substr((string)$nsfw['sex_prompt'], 0, 800) : null,
    'pricing'          => $nsfw['prostitute_pricing']      ?? ($nsfw['pricing'] ?? null),
  ];
}
if (is_array($nsfw)) {
  // Pregnancy is its own facet: it is the thing most often asked about alone,
  // and burying it inside the intimacy block made "is she pregnant?" open a
  // wall of kinks to find one flag.
  $isPreg = ($nsfw['fertility_is_pregnant'] ?? '') === true || ($nsfw['fertility_is_pregnant'] ?? '') === 'true';
  if ($isPreg || in_array('pregnancy', $focus, true)) {
    $facets['pregnancy'] = [
      'pregnant' => $isPreg,
      'father'   => $isPreg ? ($nsfw['fertility_father'] ?? null) : null,
      'progress' => $isPreg ? ($nsfw['fertility_progress'] ?? null) : null,
    ];
  }
  // Disposition — the NSFW plugin's live "seducing game" state, when nonzero.
  $intim = $nsfw['aiagent_nsfw_intimacy_data'] ?? null;
  if (is_array($intim) && (($intim['sex_disposal'] ?? 0) || ($intim['level'] ?? 0))) {
    $facets['intimacy']['disposition'] = 'level ' . ($intim['level'] ?? 0) .
      ' · desire ' . ($intim['sex_disposal'] ?? 0);
  }
}
if ($diary)    $facets['diary']    = $diary;
if ($speech)   $facets['speech']   = $speech;
if ($memories) $facets['memories'] = $memories;

// ---- whereabouts: "where is she / where does she live / what's she doing" --
// WSL sees the Windows drive, so this reads the deck's OWN exports directly:
// FollowerOrganizer.json (home/fields — always there) and mhiyh-status.json
// (her live MHiYH day — written after the Followers tab first opens each
// session; its absence is reported honestly, not silently).
if (preg_match('/\b(where|doing (now|right now|today)|live|lives|home|schedule|staying)\b/', $qlower)) {
  $wa = whereabouts_of($name);
  if ($wa) { $facets['whereabouts'] = $wa; $focus[] = 'whereabouts'; }
}

// ---- knowledge: "does she know about X / has she heard of X" ---------------
if (preg_match('/\b(?:know|knows|aware|heard)\b(?:\s+(?:about|of))?\s+(.{3,60})$/u',
               rtrim($qlower, " ?!."), $km)) {
  $ktopic = trim(preg_replace('/^(the|a|an|that|my)\s+/u', '', trim($km[1])));
  if (mb_strlen($ktopic) >= 3) {
    $kn = knowledge_of($name, $core, $nsfw, $ktopic);
    $facets['knowledge'] = $kn ?: [['d' => '', 'text' =>
      'Nothing in her profile, memories or regional lore mentions “' . $ktopic .
      '” — she likely does not know.']];
    $focus = ['knowledge'];
  }
}

// ---- chronicle: the repo tracker docs, scored against question + her name --
$chron = chronicle_hits($qtokens, $name, 3);
if ($chron) {
  $facets['chronicle'] = $chron;
  // The canon outranks a missing/false game-side flag: a pregnancy question
  // whose DB facet is absent or negative focuses the chronicle instead.
  if (in_array('pregnancy', $focus, true) &&
      empty($facets['pregnancy']['pregnant'])) $focus[] = 'chronicle';
}

$out = [
  'ok'         => true,
  'npc'        => [
    'name'   => $name,
    'id'     => $core['id']     ?? 0,
    'race'   => $core['race']   ?? ($nsfw['race'] ?? null),
    'gender' => $core['gender'] ?? ($nsfw['gender'] ?? null),
  ],
  'matchedBy'  => $bestScore >= 10 ? 'full name in question'
                : ($bestScore >= 5 ? 'name word in question'
                : ($explicit !== '' && !isset($scores[$name]) ? 'carried over from the last answer' : 'partial match')),
  'candidates' => $candidates,
  'focus'      => array_values(array_unique($focus)),
  'facets'     => $facets,
];
if ($speechNote !== '' && $speech) $out['speechNote'] = $speechNote;

if ($mode !== 'llm') reply($out);

$ctx = "NPC: {$name}" . ($core ? " ({$core['race']} {$core['gender']}, {$core['occupation']})" : '') . "\n";
foreach ($facets as $k => $v) {
  // line-list facets ({d,text} rows — diary/speech/memories/chronicle/
  // whereabouts/knowledge/mentions and anything future-shaped like them)
  if (is_array($v) && isset($v[0]) && is_array($v[0]) && array_key_exists('text', $v[0])) {
    foreach (array_slice($v, 0, 5) as $row) {
      $who = isset($row['speaker']) ? " {$row['speaker']}→{$row['listener']}" : '';
      $ctx .= strtoupper($k) . " {$row['d']}{$who}: {$row['text']}\n";
    }
    continue;
  }
  $ctx .= strtoupper($k) . ": " . (is_array($v) ? json_encode($v, JSON_UNESCAPED_UNICODE) : $v) . "\n";
}
llm_answer($out, $ctx, $question);

// ------------------------------------------------------------- LLM layer ----
// One chat completion over the retrieved context, through CHIM's own key.
// The credentials live in CHIM's connector tables (verified 2026-08-02):
//   core_profiles.llm_primary_id  → the profile's dialogue connector
//   core_llm_connector(url, model, api_badge_id)
//   core_api_badge(api_key)       → the OpenRouter key
// So the ask uses THE SAME model and key NPC dialogue does — nothing new
// to configure, and swapping CHIM's primary connector swaps ask with it.
function chim_llm_config() {
  $row = q1("SELECT c.url, c.model, b.api_key
             FROM core_profiles p
             JOIN core_llm_connector c ON c.id = p.llm_primary_id
             JOIN core_api_badge b ON b.id = c.api_badge_id
             WHERE p.llm_primary_id IS NOT NULL AND COALESCE(b.api_key,'') <> ''
             ORDER BY (p.slot = 1) DESC, p.id ASC LIMIT 1");
  if ($row) return ['url' => $row['url'], 'key' => $row['api_key'], 'model' => $row['model']];
  // fallback: any badge holding an OpenRouter key
  $b = q1("SELECT api_key FROM core_api_badge WHERE api_key LIKE 'sk-or-%' LIMIT 1");
  if ($b) return ['url' => 'https://openrouter.ai/api/v1/chat/completions',
                  'key' => $b['api_key'], 'model' => 'deepseek/deepseek-chat-v3.1'];
  return null;
}

// ------------------------------------------------------ whereabouts helper --
// Reads the deck's own exports off the Windows drive. Defensive tree-walk:
// both files are other components' outputs and their shapes may drift — we
// collect scalar fields from any object whose name matches, never index by a
// hard-coded path.
function json_find_named($node, $nameLower, &$found, $depth = 0) {
  if ($depth > 8 || !is_array($node)) return;
  $isMatch = false;
  foreach (['Name', 'name', 'Original', 'original'] as $k) {
    if (isset($node[$k]) && is_string($node[$k]) &&
        mb_strtolower($node[$k]) === $nameLower) { $isMatch = true; break; }
  }
  if ($isMatch) $found[] = $node;
  foreach ($node as $v) json_find_named($v, $nameLower, $found, $depth + 1);
}
function whereabouts_of($name) {
  $rows = [];
  $nl = mb_strtolower($name);
  $viewDir = '/mnt/e/Modding/SkyrimSE/Archived Mods/mods/Hotkey Deck (PrismaUI)/PrismaUI/views/HotkeyDeck';
  $foFile  = '/mnt/e/Modding/SkyrimSE/Archived Mods/mods/Follower Organizer (Latest)/SKSE/Plugins/FollowerOrganizer.json';

  // live MHiYH day (written when the Followers tab opens in-game)
  $mhFile = $viewDir . '/mhiyh-status.json';
  if (is_file($mhFile)) {
    $mh = json_decode(file_get_contents($mhFile), true);
    if (is_array($mh)) {
      $entry = null;
      foreach ($mh as $k => $v) {
        if (is_string($k) && mb_strtolower($k) === $nl && is_array($v)) { $entry = $v; break; }
      }
      if ($entry === null) { $f2 = []; json_find_named($mh, $nl, $f2); $entry = $f2[0] ?? null; }
      if (is_array($entry)) {
        foreach ($entry as $k => $v) {
          if (is_scalar($v) && $v !== '' && $v !== false)
            $rows[] = ['d' => 'live schedule', 'text' => $k . ': ' . (is_bool($v) ? 'yes' : $v)];
          elseif (is_array($v) && $v && array_values($v) === $v && is_scalar($v[0] ?? null))
            $rows[] = ['d' => 'live schedule', 'text' => $k . ': ' . implode(', ', array_slice($v, 0, 6))];
        }
      }
    }
  } else {
    $rows[] = ['d' => '', 'text' =>
      'Live schedule not exported yet this session — open the deck\'s Followers tab once in-game and ask again.'];
  }

  // Follower Organizer: her category, note, and the v0.10 fields (Home, …)
  if (is_file($foFile)) {
    $fo = json_decode(file_get_contents($foFile), true);
    $found = [];
    json_find_named($fo ?: [], $nl, $found);
    if ($found) {
      $m = $found[0];
      foreach (['Description' => 'note', 'description' => 'note'] as $k => $lbl) {
        if (!empty($m[$k]) && is_string($m[$k]))
          $rows[] = ['d' => 'organizer', 'text' => $lbl . ': ' . $m[$k]];
      }
      foreach (['Fields', 'fields'] as $fk) {
        if (isset($m[$fk]) && is_array($m[$fk])) {
          foreach ($m[$fk] as $k => $v)
            if (is_scalar($v) && $v !== '') $rows[] = ['d' => 'organizer', 'text' => $k . ': ' . $v];
        }
      }
    }
  }
  return $rows;
}

// -------------------------------------------------------- knowledge helper --
// "Does she know about X" = (1) her own profile prose / sex prompt / memories
// mention X (personal knowledge), (2) oghma lore topics matching X (world
// knowledge available to NPCs). Excerpts, honestly labelled by source.
function excerpt_around($text, $topic, $span = 140) {
  $at = mb_stripos($text, $topic);
  if ($at === false) return null;
  $from = max(0, $at - intdiv($span, 2));
  return ($from > 0 ? '…' : '') .
         trim(mb_substr($text, $from, $span + mb_strlen($topic))) . '…';
}
function knowledge_of($name, $core, $nsfw, $topic) {
  $rows = [];
  if ($core) {
    foreach (['npc_static_bio' => 'her bio', 'personality' => 'her personality',
              'relationships' => 'her relationships', 'goals' => 'her goals',
              'prompt_head' => 'her prompt'] as $col => $lbl) {
      if (!empty($core[$col])) {
        $ex = excerpt_around($core[$col], $topic);
        if ($ex) $rows[] = ['d' => $lbl, 'text' => $ex];
      }
    }
  }
  if (is_array($nsfw) && !empty($nsfw['sex_prompt'])) {
    $ex = excerpt_around((string)$nsfw['sex_prompt'], $topic);
    if ($ex) $rows[] = ['d' => 'her intimacy profile', 'text' => $ex];
  }
  foreach (qa("SELECT LEFT(message, 400) AS m FROM memory
               WHERE (speaker=$1 OR listener=$1) AND message ILIKE $2
               ORDER BY localts DESC LIMIT 3", [$name, '%' . $topic . '%']) as $r) {
    $ex = excerpt_around($r['m'], $topic);
    if ($ex) $rows[] = ['d' => 'her memories', 'text' => $ex];
  }
  foreach (qa("SELECT topic, LEFT(topic_desc, 220) AS d2 FROM oghma
               WHERE topic ILIKE $1 OR topic_desc ILIKE $1 LIMIT 2",
              ['%' . $topic . '%']) as $r) {
    $rows[] = ['d' => 'world lore (oghma)', 'text' => str_replace('_', ' ', $r['topic']) . ': ' . $r['d2']];
  }
  return $rows;
}

// One completion over $ctx, answer appended to $out, then reply() — shared by
// the single-NPC, aggregate and world paths. Never returns.
function llm_answer(array $out, string $ctx, string $question) {
  $llm = chim_llm_config();
  if (!$llm) { $out['answer'] = null; $out['llm_error'] = 'no LLM key found in CHIM config'; reply($out); }

  $payload = json_encode([
    'model' => $llm['model'],
    'max_tokens' => 400,
    'messages' => [
      ['role' => 'system', 'content' =>
        'You are an omniscient narrator answering questions about a Skyrim roleplay world, ' .
        'using ONLY the provided data. Always answer in THIRD person — never roleplay as an ' .
        'NPC, never use "I". 2-5 plain sentences, in-world tone, no headers or lists. ' .
        'If the data does not answer the question, say what IS known instead of inventing.'],
      ['role' => 'user', 'content' => "DATA:\n" . mb_substr($ctx, 0, 6000) . "\nQUESTION: " . $question],
    ],
  ], JSON_UNESCAPED_UNICODE);

  $ch = curl_init($llm['url']);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $llm['key']],
    CURLOPT_TIMEOUT => 45,
  ]);
  $resp = curl_exec($ch);
  $err  = curl_error($ch);
  curl_close($ch);

  if ($resp === false) { $out['answer'] = null; $out['llm_error'] = 'LLM call failed: ' . $err; reply($out); }
  $j = json_decode($resp, true);
  $answer = $j['choices'][0]['message']['content'] ?? null;
  if ($answer === null) {
    $out['answer'] = null;
    $out['llm_error'] = 'LLM returned no text' . (isset($j['error']['message']) ? ': ' . $j['error']['message'] : '');
    reply($out);
  }
  $out['answer'] = trim($answer);
  $out['model']  = $llm['model'];
  reply($out);
}
