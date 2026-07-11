import type { ReactNode } from "react";

export default function SectionHeading({
  title,
  lead,
}: {
  title: string;
  lead: ReactNode;
}) {
  return (
    <div className="mb-10">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h2>
      <p className="mt-3 max-w-2xl leading-relaxed text-default-500">{lead}</p>
    </div>
  );
}
