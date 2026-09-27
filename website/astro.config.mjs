import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const repository = "https://github.com/R1ck404/Nodepod";

export default defineConfig({
  site: "https://r1ck404.github.io",
  base: "/Nodepod",
  integrations: [
    starlight({
      title: "nodepod",
      description: "Run Node.js programs, filesystems, packages, and servers in the browser.",
      favicon: "/favicon.png",
      social: [{ icon: "github", label: "GitHub", href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/website/` },
      lastUpdated: true,
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        { label: "Getting started", items: [{ label: "Introduction", slug: "docs" }, { label: "First program", slug: "docs/getting-started/first-program" }] },
        {
          label: "Set up",
          items: [{ autogenerate: { directory: "docs/setup" } }],
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "docs/guides" } }],
        },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "docs/concepts" } }],
        },
        {
          label: "Reference",
          items: [
            { label: "SDK overview", slug: "docs/reference/sdk" },
            { label: "API reference", items: [{ autogenerate: { directory: "docs/reference/api" } }] },
          ],
        },
        { label: "Troubleshooting", slug: "docs/troubleshooting" },
      ],
      head: [
        { tag: "meta", attrs: { property: "og:site_name", content: "nodepod" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0B0B0C" } },
      ],
    }),
  ],
  vite: {
    optimizeDeps: {
      exclude: ["@r1ck404/nodepod"],
    },
  },
});
