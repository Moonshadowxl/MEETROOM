import { Card, CardBody, Chip } from "@heroui/react";
import SectionHeading from "./SectionHeading";

const levels = [
  { level: "L0", name: "Observe", desc: "Agents discuss; only humans act" },
  { level: "L1", name: "Assisted", desc: "Agents work; humans gate reviews" },
  {
    level: "L2",
    name: "Supervised",
    desc: "Peer review; humans on escalation",
  },
  {
    level: "L3",
    name: "Managed",
    desc: "Meta-agent handles ops, veto window",
  },
  { level: "L4", name: "Delegated", desc: "Full autonomy, audit trail kept" },
];

export default function Autonomy() {
  return (
    <section id="autonomy" className="scroll-mt-24 py-16">
      <SectionHeading
        title="Autonomy is a dial, not a switch"
        lead={
          <>
            Set how much rope the room gets — per session, changeable any time
            with{" "}
            <code className="font-mono text-sm text-primary">
              meetroom autonomy set
            </code>
            .
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {levels.map((item) => (
          <Card
            key={item.level}
            shadow="none"
            className="border border-default-100 bg-content1"
          >
            <CardBody className="items-center px-4 py-5 text-center">
              <Chip
                size="sm"
                variant="flat"
                color="primary"
                className="font-mono font-bold"
              >
                {item.level}
              </Chip>
              <h3 className="mt-3 text-sm font-semibold">{item.name}</h3>
              <p className="mt-1 text-xs leading-relaxed text-default-500">
                {item.desc}
              </p>
            </CardBody>
          </Card>
        ))}
      </div>
    </section>
  );
}
