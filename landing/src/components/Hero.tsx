import { Button, Chip, Link } from "@heroui/react";
import Terminal from "./Terminal";

export default function Hero() {
  return (
    <section className="pb-16 pt-24 text-center sm:pt-28">
      <Chip
        variant="bordered"
        size="sm"
        className="mb-8 border-default-200 text-default-500"
      >
        MIT licensed · zero runtime dependencies
      </Chip>

      <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
        Run a whole team of coding agents in one repo.{" "}
        <span className="text-primary">Zero collisions.</span>
      </h1>

      <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-default-500 sm:text-lg">
        Meetroom gives CLI coding agents —{" "}
        <span className="font-medium text-foreground">
          Claude Code, Codex, GLM, DeepSeek
        </span>
        , anything that runs bash — a shared room with file claims, a task
        board, peer review gates, and human escalation. One CLI, a local
        daemon, nothing else to install.
      </p>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Button
          as={Link}
          href="#start"
          color="primary"
          size="lg"
          className="font-semibold"
        >
          Get started
        </Button>
        <Button
          as={Link}
          href="https://github.com/moonshadowxl/meetroom"
          isExternal
          size="lg"
          variant="bordered"
          className="border-default-200 font-medium"
        >
          View on GitHub
        </Button>
      </div>

      <Terminal />
    </section>
  );
}
