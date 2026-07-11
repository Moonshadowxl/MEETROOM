import { heroui } from "@heroui/react";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,mjs,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "ui-monospace",
          "SF Mono",
          "Cascadia Code",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [
    heroui({
      defaultTheme: "dark",
      themes: {
        dark: {
          colors: {
            background: "#0a0d13",
            foreground: "#dde2ec",
            focus: "#5eead4",
            content1: "#10141d",
            content2: "#151a26",
            content3: "#1c2333",
            content4: "#232a3a",
            default: {
              50: "#10141d",
              100: "#151a26",
              200: "#232a3a",
              300: "#35405a",
              400: "#4b5670",
              500: "#8b93a7",
              600: "#a5acbd",
              700: "#c0c6d3",
              800: "#dde2ec",
              900: "#f2f4f8",
              DEFAULT: "#232a3a",
              foreground: "#dde2ec",
            },
            primary: {
              DEFAULT: "#5eead4",
              foreground: "#06281f",
            },
            secondary: {
              DEFAULT: "#818cf8",
              foreground: "#0a0d13",
            },
          },
        },
      },
    }),
  ],
};
