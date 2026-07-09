import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Guild } from "../../shared/types.js";
import { entityId } from "../../shared/ids.js";
import { csv, fail, type Parsed } from "../client.js";

// V3 #10 — guilds are a user-global saved preset over agent profiles, stored
// at ~/.meetroom/guilds.json. Pure convenience layer, no new mechanics.

function guildsPath(): string {
  return join(process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom"), "guilds.json");
}

export function loadGuilds(): Guild[] {
  const p = guildsPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Guild[];
  } catch {
    return [];
  }
}

function saveGuilds(guilds: Guild[]): void {
  mkdirSync(join(guildsPath(), ".."), { recursive: true });
  writeFileSync(guildsPath(), JSON.stringify(guilds, null, 2));
}

export function cmdGuild(parsed: Parsed): void {
  const [sub, ...rest] = parsed.positional;
  if (sub === "create") {
    const name = rest[0];
    if (!name) fail('usage: meetroom guild create "<name>" --members "ident:role[:tier],..."');
    const memberSpecs = csv(parsed.flags.members);
    if (!memberSpecs?.length) fail("--members required, e.g. --members \"claude:Implementer:high,codex:Reviewer:medium\"");
    const members: Guild["members"] = memberSpecs.map((spec) => {
      const [agentIdentity, defaultRole, costTier] = spec.split(":");
      if (!agentIdentity || !defaultRole) fail(`bad member spec "${spec}" — expected ident:role[:tier]`);
      const tier: Guild["members"][number]["costTier"] =
        costTier === "low" || costTier === "medium" || costTier === "high" ? costTier : undefined;
      return { agentIdentity, defaultRole, costTier: tier };
    });
    const guilds = loadGuilds().filter((g) => g.name !== name);
    guilds.push({ id: entityId("guild"), name, members });
    saveGuilds(guilds);
    console.log(`guild "${name}" saved with ${members.length} members (start with: meetroom start --guild "${name}")`);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const guilds = loadGuilds();
    if (!guilds.length) return console.log("no guilds saved");
    for (const g of guilds) {
      console.log(`${g.name}:`);
      for (const m of g.members) console.log(`  - ${m.agentIdentity} (${m.defaultRole}${m.costTier ? `, ${m.costTier}` : ""})`);
    }
    return;
  }
  fail(`unknown guild subcommand "${sub}" (create | list)`);
}
