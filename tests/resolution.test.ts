import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import {
  createProposal,
  objectToProposal,
  resolveProposal,
  sweepProposalTimeouts,
  voteOnProposal,
} from "../src/daemon/resolution.js";
import type { Agent, Session } from "../src/shared/types.js";

function setup(agentCount: number): { reg: Registry; session: Session; agents: Agent[] } {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const session = reg.createSession({ type: "mmm", cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  const agents: Agent[] = [];
  for (let i = 0; i < agentCount; i++) {
    const a: Agent = {
      id: `agent-${i}`,
      name: `agent-${i}`,
      role: "Implementer",
      identity: `agent-${i}`,
      status: "active",
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    agents.push(a);
    session.agents.push(a);
  }
  return { reg, session, agents };
}

test("proposal with no objections resolves on author resolve", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "use snake_case for DB columns");
  const r = resolveProposal(reg, session, p.id, agents[0].id);
  assert.equal(r.ok, true);
  assert.equal(p.status, "resolved");
});

test("unobjected proposal auto-resolves after the objection window", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "adopt vitest");
  p.createdAt = new Date(Date.now() - 6 * 60_000).toISOString();
  session.config.objectionTimeoutMinutes = 5;
  sweepProposalTimeouts(reg, session);
  assert.equal(p.status, "resolved");
});

test("author cannot object to their own proposal; objection marks contested", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "rewrite in rust");
  assert.equal(objectToProposal(reg, session, p.id, agents[0].id, "self").ok, false);
  assert.equal(objectToProposal(reg, session, p.id, agents[1].id, "scope creep").ok, true);
  assert.equal(p.status, "contested");
});

test("2-agent room: contested proposal escalates to human after one round", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "rewrite in rust");
  objectToProposal(reg, session, p.id, agents[1].id, "scope creep");
  resolveProposal(reg, session, p.id, agents[0].id, "it's worth it");
  assert.equal(p.status, "escalated");
  assert.ok(session.events.some((e) => e.type === "escalation"));
});

test("3+ agent room: contested proposal goes to a vote; majority resolves", () => {
  const { reg, session, agents } = setup(3);
  const p = createProposal(reg, session, agents[0].id, "split the API module");
  objectToProposal(reg, session, p.id, agents[1].id, "premature");
  resolveProposal(reg, session, p.id, agents[0].id, "file is 3k lines");
  assert.equal(p.status, "voting");
  voteOnProposal(reg, session, p.id, agents[0].id, "yes");
  voteOnProposal(reg, session, p.id, agents[1].id, "no");
  voteOnProposal(reg, session, p.id, agents[2].id, "yes");
  assert.equal(p.status, "resolved");
});

test("tie without a lead escalates; lead tie-break resolves instead", () => {
  const tie = setup(4);
  let p = createProposal(tie.reg, tie.session, tie.agents[0].id, "proposal A");
  objectToProposal(tie.reg, tie.session, p.id, tie.agents[1].id, "no");
  resolveProposal(tie.reg, tie.session, p.id, tie.agents[0].id, "yes");
  voteOnProposal(tie.reg, tie.session, p.id, tie.agents[0].id, "yes");
  voteOnProposal(tie.reg, tie.session, p.id, tie.agents[1].id, "no");
  voteOnProposal(tie.reg, tie.session, p.id, tie.agents[2].id, "yes");
  voteOnProposal(tie.reg, tie.session, p.id, tie.agents[3].id, "no");
  assert.equal(p.status, "escalated");

  const lead = setup(4);
  lead.session.config.leadAgentId = lead.agents[0].id;
  p = createProposal(lead.reg, lead.session, lead.agents[0].id, "proposal B");
  objectToProposal(lead.reg, lead.session, p.id, lead.agents[1].id, "no");
  resolveProposal(lead.reg, lead.session, p.id, lead.agents[0].id, "yes");
  voteOnProposal(lead.reg, lead.session, p.id, lead.agents[0].id, "yes");
  voteOnProposal(lead.reg, lead.session, p.id, lead.agents[1].id, "no");
  voteOnProposal(lead.reg, lead.session, p.id, lead.agents[2].id, "yes");
  voteOnProposal(lead.reg, lead.session, p.id, lead.agents[3].id, "no");
  assert.equal(p.status, "resolved");
});

test("objecting again after the author's response concludes instead of looping", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "drop the ORM");
  objectToProposal(reg, session, p.id, agents[1].id, "too risky");
  resolveProposal(reg, session, p.id, agents[0].id, "we have tests");
  assert.equal(p.status, "escalated"); // 2 agents: no vote possible
  // Further objections on a terminal proposal are rejected.
  assert.equal(objectToProposal(reg, session, p.id, agents[1].id, "still risky").ok, false);
});

test("human can force-resolve an escalated proposal", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "drop the ORM");
  objectToProposal(reg, session, p.id, agents[1].id, "too risky");
  resolveProposal(reg, session, p.id, agents[0].id, "we have tests");
  assert.equal(p.status, "escalated");
  const r = resolveProposal(reg, session, p.id, "human");
  assert.equal(r.ok, true);
  assert.equal(p.status, "resolved");
});
