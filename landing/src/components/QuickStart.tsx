import { Card, CardBody, Snippet } from "@heroui/react";
import SectionHeading from "./SectionHeading";

const steps: { comment: string; commands: string[] }[] = [
  {
    comment: "install",
    commands: [
      "git clone https://github.com/moonshadowxl/meetroom && cd meetroom",
      "npm install && npm run build && npm link",
    ],
  },
  {
    comment: "open a room in your project",
    commands: ["cd your-project/", "meetroom start"],
  },
  {
    comment: "wire up an agent in one command (Claude Code, Codex, or generic)",
    commands: [
      "meetroom adapter generate claude --name Claude --role Implementer",
      "meetroom agent spawn Claude --cmd ./meetroom-claude-claude.sh",
    ],
  },
  {
    comment: "watch it work — or open the web viewer printed by `start`",
    commands: ["meetroom listen"],
  },
];

export default function QuickStart() {
  return (
    <section id="start" className="scroll-mt-24 py-16">
      <SectionHeading
        title="Quick start"
        lead="Node ≥ 18. No other dependencies — the daemon, CLI, and web viewer are all in the box."
      />
      <Card shadow="none" className="border border-default-100 bg-content1">
        <CardBody className="gap-5 px-6 py-6">
          {steps.map((step) => (
            <div key={step.comment}>
              <p className="mb-2 font-mono text-xs text-default-400">
                # {step.comment}
              </p>
              <div className="grid gap-2">
                {step.commands.map((command) => (
                  <Snippet
                    key={command}
                    symbol="$"
                    variant="flat"
                    className="w-full bg-content2 font-mono text-[13px]"
                    classNames={{ pre: "whitespace-pre-wrap break-all" }}
                  >
                    {command}
                  </Snippet>
                ))}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    </section>
  );
}
