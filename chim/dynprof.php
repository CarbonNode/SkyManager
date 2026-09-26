<?php
/* dynprof.php — run CHIM's dynamic-profile scheduler for ONE NPC, from the CLI.
 *
 *   php dynprof.php "<npc name>"      -> prints DYNPROF_RESULT {"updated":N,"npcs":N,"events":N}
 *
 * A CLI twin of service/manager.php's bootstrap (same requires as the
 * dynamicprofile processor's entrypoint), so lib/dynamic_profile_scheduler.php
 * dps_run($name) runs with the connectors, player name and interaction gate CHIM
 * itself uses. Installed next to ask.php (ext/deck_ask/); called by ask.php's
 * dynprof_refresh mode. Nothing here writes on its own — dps_run does the work.
 */
$engine = realpath(__DIR__ . '/../../') . '/';
$name = trim((string)($argv[1] ?? ''));
if ($name === '') { echo "DYNPROF_RESULT " . json_encode(['updated' => 0, 'npcs' => 0, 'events' => 0, 'why' => 'no npc name']) . "\n"; exit(1); }
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
if (!isset($GLOBALS['db'])) $GLOBALS['db'] = new sql();
require_once $engine . 'prompts/command_prompt.php';
require_once $engine . 'lib/chat_helper_functions.php';
require_once $engine . 'lib/data_functions.php';
require_once $engine . 'lib/dynamic_update_util.php';
require_once $engine . 'lib/core/npc_master.class.php';
require_once $engine . 'lib/core/core_profiles.class.php';
require_once $engine . 'lib/core/llm_connector.class.php';
require_once $engine . 'lib/dynamic_profile_scheduler.php';
/* Name the gate that would stop dps_run BEFORE running it, in the scheduler's own
 * terms, so the flyout can say why nothing happened instead of guessing. */
$why = '';
try {
  $conn = ptp_connect();
  if ($conn) {
    $clock = dps_state($conn, 'DYNAMIC_PROFILE_CLOCK');
    $cand = null;
    foreach (dps_candidates($conn) as $c) { if ($c['name'] === $name) { $cand = $c; break; } }
    if (!$cand) $why = $name . ' is not a CHIM NPC the scheduler knows';
    elseif (!$cand['enabled']) $why = 'her dynamic profile is off, locked, or has no fields selected in CHIM';
    elseif (!$clock) $why = 'the dynamic-profile clock has never started (open CHIM once with the game running)';
    elseif (time() - (int)($clock['seen'] ?? 0) > 300) $why = 'the game has not talked to CHIM in the last 5 minutes — say something to an NPC first';
    elseif (function_exists('chimInteractionAllowed') && !chimInteractionAllowed()) $why = 'CHIM is not talking to the game right now (interaction gate closed)';
    else {
      $state = dps_state($conn, $cand['key']);
      if (!$state || ($state['epoch'] ?? '') !== ($clock['epoch'] ?? '-')) $why = 'her scheduler state belongs to an older session — it resets on the next CHIM tick';
      elseif (!dps_due($state, $cand['policy'], (int)$clock['gamets'], time(), true)) {
        $cool = (int)($cand['policy']['DYNAMIC_PROFILE_COOLDOWN_MINUTES'] ?? 0) * 60;
        $left = max(0, $cool - (time() - (int)($state['attempt'] ?? 0)));
        $why = 'attempt cooldown — CHIM rewrote (or tried) less than ' . round($cool / 60) . ' min ago, ' . $left . ' s left';
      }
      elseif (!dps_connector_ready($cand)) $why = 'the Profiles LLM connector is not ready (no driver/model)';
      elseif (dps_context($conn, $cand, (int)$clock['gamets']) === '') $why = 'no new events for her since the last rewrite — nothing to learn from';
    }
    pg_close($conn);
  }
} catch (Throwable $e) { $why = 'pre-check failed: ' . $e->getMessage(); }
$res = dps_run($name);
if (intval($res['npcs'] ?? 0) > 0) $why = '';
elseif ($why === '') $why = 'the scheduler declined without saying why (another run may hold its lock)';
$res['why'] = $why;
echo "DYNPROF_RESULT " . json_encode($res) . "\n";
