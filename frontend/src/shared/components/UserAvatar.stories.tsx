import UserAvatar from "./UserAvatar.jsx";

const meta = {
  title: "Design System/Primitives/UserAvatar",
  component: UserAvatar,
  tags: ["autodocs"],
  args: { name: "Ana Ribeiro", className: "h-14 w-14 text-lg" },
  argTypes: {
    name: { control: "text" },
    photoPath: { control: "text" },
    className: { control: "text" },
  },
};

export default meta;
export const Playground = {};

export const Variantes = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      <div className="grid justify-items-center gap-2">
        <UserAvatar name="Ana Ribeiro" className="h-14 w-14 text-lg" />
        <span className="text-xs text-text-secondary">Dois nomes</span>
      </div>
      <div className="grid justify-items-center gap-2">
        <UserAvatar name="Carlos" className="h-10 w-10 text-sm" />
        <span className="text-xs text-text-secondary">Nome único</span>
      </div>
      <div className="grid justify-items-center gap-2">
        <UserAvatar name="" className="h-8 w-8 text-xs" />
        <span className="text-xs text-text-secondary">Sem nome</span>
      </div>
    </div>
  ),
};
