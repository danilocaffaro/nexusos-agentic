import migration0000 from "../../../drizzle/0000_icy_power_man.sql?raw";
import migration0001 from "../../../drizzle/0001_abandoned_ultimatum.sql?raw";
import migration0002 from "../../../drizzle/0002_flashy_mimic.sql?raw";
import migration0003 from "../../../drizzle/0003_tiny_lilandra.sql?raw";
import migration0004 from "../../../drizzle/0004_tan_layla_miller.sql?raw";
import migration0005 from "../../../drizzle/0005_hard_snowbird.sql?raw";
import migration0006 from "../../../drizzle/0006_wonderful_madame_web.sql?raw";
import migration0007 from "../../../drizzle/0007_heavy_brood.sql?raw";
import migration0008 from "../../../drizzle/0008_plain_mongu.sql?raw";
import migration0009 from "../../../drizzle/0009_allow_nonhuman_presence.sql?raw";
import migration0010 from "../../../drizzle/0010_illegal_mathemanic.sql?raw";
import migration0011 from "../../../drizzle/0011_dusty_mulholland_black.sql?raw";
import migration0012 from "../../../drizzle/0012_tired_smasher.sql?raw";
import migration0013 from "../../../drizzle/0013_new_justice.sql?raw";
import migration0014 from "../../../drizzle/0014_flimsy_the_spike.sql?raw";
import migration0015 from "../../../drizzle/0015_spotty_firestar.sql?raw";
import migration0016 from "../../../drizzle/0016_busy_vision.sql?raw";
import migration0017 from "../../../drizzle/0017_nifty_prism.sql?raw";
import migration0018 from "../../../drizzle/0018_s6b2_lease_convergence.sql?raw";
import migration0019 from "../../../drizzle/0019_s6b3_capability_history.sql?raw";
import migration0020 from "../../../drizzle/0020_s6b3_capability_mutation.sql?raw";
import migration0021 from "../../../drizzle/0021_wakeful_talkback.sql?raw";
import migration0022 from "../../../drizzle/0022_s6b3_admission_policy.sql?raw";
import migration0023 from "../../../drizzle/0023_s6b3_assigned_storage.sql?raw";
import migration0024 from "../../../drizzle/0024_chilly_shinko_yamashiro.sql?raw";
import migration0025 from "../../../drizzle/0025_charming_forge.sql?raw";
import migration0026 from "../../../drizzle/0026_sticky_valkyrie.sql?raw";
import migration0027 from "../../../drizzle/0027_s6b4_engine_completion_activation.sql?raw";
import migration0028 from "../../../drizzle/0028_classy_fabian_cortez.sql?raw";

import { finalHostedD1Triggers } from "@/src/domain/hosted-d1-triggers";

const BATCH_SIZE = 40;
const TRIGGERS = finalHostedD1Triggers([
  migration0000,
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0025,
  migration0026,
  migration0027,
  migration0028,
]);
const EXPECTED_NAMES = TRIGGERS.map(({ name }) => name);
let readiness: Promise<void> | null = null;

export async function ensureHostedD1Triggers(
  d1: D1Database,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  if (!readiness) {
    readiness = installHostedD1Triggers(d1).catch((error) => {
      readiness = null;
      throw error;
    });
  }
  await readiness;
}

async function installHostedD1Triggers(d1: D1Database): Promise<void> {
  for (let offset = 0; offset < TRIGGERS.length; offset += BATCH_SIZE) {
    const results = await d1.batch(
      TRIGGERS.slice(offset, offset + BATCH_SIZE).map(({ createSql }) =>
        d1.prepare(createSql),
      ),
    );
    if (
      results.length === 0 ||
      results.some((result) => result.success !== true)
    ) {
      throw new Error("Hosted D1 trigger installation failed.");
    }
  }

  const observed = await d1
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'trigger'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  const names = observed.results.map(({ name }) => name);
  if (
    observed.success !== true ||
    names.length !== EXPECTED_NAMES.length ||
    names.some((name, index) => name !== EXPECTED_NAMES[index])
  ) {
    throw new Error("Hosted D1 trigger verification failed.");
  }
}
