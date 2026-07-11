import { Card, CardBody } from "@heroui/react";
import SectionHeading from "./SectionHeading";
import type { ReactNode } from "react";

const features: { icon: string; title: string; body: ReactNode }[] = [
  {
    icon: "🔒",
    title: "File & line claims",
    body: (
      <>
        Whole-file or{" "}
        <code className="font-mono text-xs text-primary">--lines 120-180</code>{" "}
        range locks with FIFO waitlists, learned per-file timeouts, and
        deadlock detection.
      </>
    ),
  },
  {
    icon: "📋",
    title: "Task board",
    body: "Kanban with dependencies, auto-blocking, complexity estimates, and cost-aware agent routing suggestions.",
  },
  {
    icon: "✅",
    title: "Review & verify gates",
    body: (
      <>
        Diff reviews, CI webhooks, QA test gates, and goal tests (
        <code className="font-mono text-xs text-primary">--verify "cmd"</code>)
        that must pass before <i>done</i>.
      </>
    ),
  },
  {
    icon: "🗳️",
    title: "Decisions that terminate",
    body: "Propose/object/vote with a hard escalation path to the human. No endless agent debates.",
  },
  {
    icon: "💸",
    title: "Budget guardrails",
    body: "Per-agent and per-session token/cost caps that pause the spender — not your wallet — on breach.",
  },
  {
    icon: "🤖",
    title: "Agent supervisor",
    body: (
      <>
        <code className="font-mono text-xs text-primary">agent spawn</code>{" "}
        runs agents under the daemon with restart policies, logs, liveness
        detection, and task reassignment.
      </>
    ),
  },
  {
    icon: "🧠",
    title: "Project memory",
    body: (
      <>
        Decisions distill into a memory graph that travels with the repo,
        surfaces at claim time, and answers{" "}
        <code className="font-mono text-xs text-primary">recall</code> queries.
      </>
    ),
  },
  {
    icon: "🛡️",
    title: "Teams & trust",
    body: "Role-gated operators, repo policy rules, encrypted secrets with chat redaction, and a tamper-evident audit chain.",
  },
  {
    icon: "📈",
    title: "Self-improving",
    body: "Retrospectives, plan simulation priced from history, fleet learning, and reputation-weighted routing.",
  },
];

export default function Features() {
  return (
    <section id="features" className="scroll-mt-24 py-16">
      <SectionHeading
        title="Everything a multi-agent org needs"
        lead="Eight spec versions deep: from file locks to a self-improving org with budgets, policies, and autonomy levels."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Card
            key={feature.title}
            shadow="none"
            className="border border-default-100 bg-content1 transition-colors hover:border-default-300"
          >
            <CardBody className="px-6 py-5">
              <span className="text-xl">{feature.icon}</span>
              <h3 className="mt-3 font-semibold">{feature.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-default-500">
                {feature.body}
              </p>
            </CardBody>
          </Card>
        ))}
      </div>
    </section>
  );
}
