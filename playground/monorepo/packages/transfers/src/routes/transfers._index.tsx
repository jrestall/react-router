import { href } from "react-router";
import type { Route } from "./+types/transfers._index";

export function loader({ params }: Route.LoaderArgs) {
  return { name: `Super cool transfers product #${params.id}` };
}

export default function Component({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <h1>{loaderData.name}</h1>
      <a href={href("/accounts")} />
      <a href={href("/transfers/:id", { id: "123" })} />
    </div>
  );
}
