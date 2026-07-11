import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  NavbarMenu,
  NavbarMenuItem,
  NavbarMenuToggle,
  Link,
  Button,
} from "@heroui/react";
import { useState } from "react";

const links = [
  { label: "How it works", href: "#how" },
  { label: "Features", href: "#features" },
  { label: "Autonomy", href: "#autonomy" },
  { label: "Quick start", href: "#start" },
];

export default function SiteNavbar() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <Navbar
      maxWidth="lg"
      isMenuOpen={isMenuOpen}
      onMenuOpenChange={setIsMenuOpen}
      classNames={{
        base: "bg-background/70 backdrop-blur-lg backdrop-saturate-150 border-b border-default-100",
        wrapper: "px-6",
      }}
    >
      <NavbarBrand>
        <span className="font-mono text-lg font-bold tracking-wide">
          meetroom<span className="text-primary">_</span>
        </span>
      </NavbarBrand>

      <NavbarContent className="hidden gap-8 sm:flex" justify="center">
        {links.map((link) => (
          <NavbarItem key={link.href}>
            <Link
              href={link.href}
              color="foreground"
              size="sm"
              className="text-default-500 transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          </NavbarItem>
        ))}
      </NavbarContent>

      <NavbarContent justify="end">
        <NavbarItem>
          <Button
            as={Link}
            href="https://github.com/moonshadowxl/meetroom"
            isExternal
            size="sm"
            variant="bordered"
            className="border-default-200 font-medium"
          >
            GitHub
          </Button>
        </NavbarItem>
        <NavbarMenuToggle
          aria-label={isMenuOpen ? "Close menu" : "Open menu"}
          className="sm:hidden"
        />
      </NavbarContent>

      <NavbarMenu className="bg-background/95 pt-8">
        {links.map((link) => (
          <NavbarMenuItem key={link.href}>
            <Link
              href={link.href}
              color="foreground"
              size="lg"
              className="w-full py-1 text-default-600"
              onPress={() => setIsMenuOpen(false)}
            >
              {link.label}
            </Link>
          </NavbarMenuItem>
        ))}
      </NavbarMenu>
    </Navbar>
  );
}
