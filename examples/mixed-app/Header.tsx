import { useSearchParams } from "react-router-dom";
import { useUiStore } from "./stores/ui";

export function Header() {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab");
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  return (
    <header className={sidebarOpen ? "with-sidebar" : ""}>
      <span>{tab}</span>
      <button
        onClick={() => useUiStore.setState({ sidebarOpen: !sidebarOpen })}
      >
        menu
      </button>
    </header>
  );
}
