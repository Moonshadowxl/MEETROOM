import SiteNavbar from "./components/SiteNavbar";
import Hero from "./components/Hero";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import Autonomy from "./components/Autonomy";
import QuickStart from "./components/QuickStart";
import Footer from "./components/Footer";

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNavbar />
      <main className="mx-auto max-w-5xl px-6">
        <Hero />
        <HowItWorks />
        <Features />
        <Autonomy />
        <QuickStart />
      </main>
      <Footer />
    </div>
  );
}
