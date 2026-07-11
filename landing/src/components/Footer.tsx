import { Divider, Link } from "@heroui/react";

export default function Footer() {
  return (
    <footer className="mt-16">
      <Divider className="bg-default-100" />
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-10 text-sm text-default-500">
        <span>
          meetroom<span className="text-primary">_</span> — MIT licensed
        </span>
        <div className="flex gap-5">
          <Link
            href="https://github.com/moonshadowxl/meetroom"
            isExternal
            size="sm"
            className="text-default-500 hover:text-foreground"
          >
            GitHub
          </Link>
          <Link
            href="https://github.com/moonshadowxl/meetroom/blob/main/GUIDE.md"
            isExternal
            size="sm"
            className="text-default-500 hover:text-foreground"
          >
            Guide
          </Link>
          <Link
            href="https://github.com/moonshadowxl/meetroom/tree/main/specs"
            isExternal
            size="sm"
            className="text-default-500 hover:text-foreground"
          >
            Specs
          </Link>
        </div>
      </div>
    </footer>
  );
}
