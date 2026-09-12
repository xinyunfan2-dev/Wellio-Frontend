import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "@/components/concept/Hero";
import { ReadinessScene } from "@/components/concept/ReadinessScene";
import { ScreenSpotlight } from "@/components/concept/ScreenSpotlight";
import { DownloadPanel } from "@/components/concept/DownloadPanel";

const TITLE = "Wellio — A fitness agent that re-plans on the spot";
const DESCRIPTION =
  "Wellio remembers your goal, your gym's equipment and what you have eaten today, then rewrites training and meal plans the moment reality changes.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="min-h-screen bg-paper">
      <Hero />
      <ReadinessScene />
      <ScreenSpotlight />
      <DownloadPanel />
    </main>
  );
}
