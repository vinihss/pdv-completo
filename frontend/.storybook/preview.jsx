import "../src/index.css";
import ThemeCanvas from "./ThemeCanvas.jsx";

const preview = {
  globalTypes: {
    colorScheme: {
      name: "Tema",
      description: "Alterna entre o tema claro e o escuro",
      defaultValue: "light",
      toolbar: {
        icon: "circlehollow",
        items: [
          { value: "light", icon: "sun", title: "Claro" },
          { value: "dark", icon: "moon", title: "Escuro" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: "centered",
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: "error",
    },
    backgrounds: {
      disable: true,
    },
    docs: {
      toc: true,
    },
  },
  decorators: [
    (Story, context) => <ThemeCanvas Story={Story} colorScheme={context.globals.colorScheme ?? "light"} />,
  ],
};

export default preview;
