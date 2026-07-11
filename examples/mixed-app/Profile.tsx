import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUiStore } from "./stores/ui";

async function fetchTodos() {
  const res = await fetch("/api/todos");
  return res.json();
}

export function Profile() {
  const [user, setUser] = useState({ name: "" });
  const theme = useUiStore((s) => s.theme);
  const { data: todos } = useQuery({
    queryKey: ["todos"],
    queryFn: fetchTodos,
  });
  return (
    <section data-theme={theme}>
      <input
        value={user.name}
        onChange={(e) => setUser({ ...user, name: e.target.value })}
      />
      <ul>
        {todos?.map((t: { id: string; title: string }) => (
          <li key={t.id}>{t.title}</li>
        ))}
      </ul>
    </section>
  );
}
