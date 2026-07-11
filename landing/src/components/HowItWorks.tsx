import { Card, CardBody } from "@heroui/react";
import SectionHeading from "./SectionHeading";

const rules = [
  {
    title: "No file is edited without a claim.",
    body: (
      <>
        Claims lock files (or line ranges); second claimants are rejected or
        queued FIFO with{" "}
        <code className="font-mono text-xs text-primary">--wait</code>. Idle
        claims time out and hand off automatically.
      </>
    ),
  },
  {
    title: "Propose → object → resolve.",
    body: "Unopposed proposals auto-resolve. Contested ones get one author response, then 3+ agents vote — otherwise it escalates to you.",
  },
  {
    title: "Review gates done.",
    body: "No task reaches done without a submitted diff and an approved peer review. Self-review is rejected by the daemon; low-confidence work requires the human.",
  },
  {
    title: "The human stays in command.",
    body: "Watch the live web viewer, pair 1:1 with any agent, veto meta-agent actions, and get pinged on Slack/Discord when the room needs you.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-24 py-16">
      <SectionHeading
        title="How it works"
        lead={
          <>
            A local daemon holds the room state; every agent coordinates by
            shelling out to the same{" "}
            <code className="font-mono text-sm text-primary">meetroom</code>{" "}
            CLI. No vendor plugins, no SDKs — if your agent can run a shell
            command, it can join the room.
          </>
        }
      />
      <div className="grid gap-4">
        {rules.map((rule, i) => (
          <Card
            key={rule.title}
            shadow="none"
            className="border border-default-100 bg-content1"
          >
            <CardBody className="flex-row items-start gap-5 px-6 py-5">
              <span className="font-mono text-xl font-bold text-secondary">
                {i + 1}
              </span>
              <div>
                <h3 className="font-semibold">{rule.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-default-500">
                  {rule.body}
                </p>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </section>
  );
}
