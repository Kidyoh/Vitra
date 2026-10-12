import React from "react";
import { Hero } from "./components/landing/Hero";
import { Manifesto } from "./components/landing/Manifesto";
import { GitVisualDAG } from "./components/landing/GitVisualDAG";
import { FeatureGrid } from "./components/landing/FeatureGrid";
import { McpIntegration } from "./components/landing/McpIntegration";
import { CodeExport } from "./components/landing/CodeExport";
import { Footer } from "./components/landing/Footer";

export default function Home() {
  return (
    <div className="landing min-h-screen bg-background text-foreground flex flex-col overflow-x-clip selection:bg-foreground selection:text-background">
      <main className="flex-1">
        <Hero />
        <Manifesto />
        <GitVisualDAG />
        <FeatureGrid />
        <McpIntegration />
        <CodeExport />
      </main>
      <Footer />
    </div>
  );
}
