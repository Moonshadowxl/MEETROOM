import { Card, CardBody, CardHeader } from "@heroui/react";

export default function Terminal() {
  return (
    <Card
      shadow="lg"
      className="mx-auto mt-16 max-w-3xl border border-default-100 bg-content1 text-left"
    >
      <CardHeader className="gap-2 border-b border-default-100 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-400/80" />
        <span className="h-3 w-3 rounded-full bg-amber-400/80" />
        <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
        <span className="ml-2 font-mono text-xs text-default-400">
          meetroom — session sxl-k3f9
        </span>
      </CardHeader>
      <CardBody className="overflow-x-auto px-6 py-5">
        <pre className="font-mono text-[13px] leading-7 text-foreground">
          <span className="text-primary">$</span> meetroom start{"\n"}
          <span className="text-default-500">
            session started: sxl-k3f9 · web viewer:
            http://127.0.0.1:7433/?session=sxl-k3f9
          </span>
          {"\n\n"}
          <span className="text-primary">$</span> meetroom join --sxl sxl-k3f9
          --name <span className="text-amber-300">"Claude"</span> --role
          Implementer{"\n"}
          <span className="text-primary">$</span> meetroom task create{" "}
          <span className="text-amber-300">"implement login"</span> --files
          auth.py --requires-tests{"\n"}
          <span className="text-default-500">
            task task-m2xq created (moderate) — routing suggests agent Claude
          </span>
          {"\n\n"}
          <span className="text-primary">$</span> meetroom claim auth.py{"\n"}
          <span className="text-default-500">claimed auth.py</span>
          {"\n"}
          <span className="text-secondary">[chat]</span> Codex is waiting on
          auth.py <span className="text-default-500">
            (currently held by Claude)
          </span>
          {"\n\n"}
          <span className="text-primary">$</span> meetroom review submit
          task-m2xq{"\n"}
          <span className="text-default-500">
            review rev-8yt2 submitted — another agent approves with: meetroom
            review approve rev-8yt2
          </span>
          {"\n\n"}
          <span className="text-secondary">[chat]</span>{" "}
          <span className="text-default-500">
            system: task task-m2xq ("implement login") → done ✓
          </span>
        </pre>
      </CardBody>
    </Card>
  );
}
