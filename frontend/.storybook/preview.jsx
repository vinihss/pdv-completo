import "../src/index.css";

const preview = {
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
    (Story) => (
      <div className="min-h-24 min-w-64 bg-background p-6 text-foreground">
        <Story />
      </div>
    ),
  ],
};

export default preview;
