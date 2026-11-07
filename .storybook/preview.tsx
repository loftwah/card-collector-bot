import type { Decorator, Preview } from "@storybook/react-vite";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import { useEffect } from "react";
import "../src/styles/global.css";
import "./preview.css";

const reducedMotion: Decorator = (Story, context) => {
  const reduce = context.globals.reducedMotion === "reduce";

  useEffect(() => {
    if (!reduce) return;
    const original = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      const result = original(query);
      if (!query.includes("prefers-reduced-motion")) return result;
      return {
        ...result,
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      } as MediaQueryList;
    }) as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }, [reduce]);

  return <Story />;
};

const preview: Preview = {
  decorators: [
    withThemeByDataAttribute({
      themes: { light: "light", dark: "dark" },
      defaultTheme: "light",
      attributeName: "data-theme",
      parentSelector: "html",
    }),
    reducedMotion,
  ],
  globalTypes: {
    reducedMotion: {
      description: "Preview the static, reduced-motion presentation",
      defaultValue: "no-preference",
      toolbar: {
        icon: "transfer",
        items: [
          { value: "no-preference", title: "Motion allowed" },
          { value: "reduce", title: "Reduced motion" },
        ],
      },
    },
  },
  parameters: {
    layout: "padded",
    viewport: {
      options: {
        phone320: { name: "Phone 320", styles: { width: "320px", height: "720px" } },
        phone390: { name: "Phone 390", styles: { width: "390px", height: "844px" } },
        tablet768: { name: "Tablet 768", styles: { width: "768px", height: "1024px" } },
        desktop1440: { name: "Desktop 1440", styles: { width: "1440px", height: "1000px" } },
      },
    },
    a11y: {
      test: "error",
    },
    docs: {
      toc: true,
    },
  },
};

export default preview;
