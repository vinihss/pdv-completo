import ThemeToggle from "./ThemeToggle.jsx";

const meta = {
  title: "Design System/Patterns/ThemeToggle",
  component: ThemeToggle,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
};

export default meta;

export const AlternarTema = {
  render: () => (
    <div className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-5">
      <div>
        <p className="text-sm font-semibold">Aparência</p>
        <p className="mt-1 text-xs text-text-secondary">
          A preferência fica salva neste dispositivo.
        </p>
      </div>
      <ThemeToggle />
    </div>
  ),
};
