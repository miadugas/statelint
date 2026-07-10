import { useEffect, useState } from "react";

export function App() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    fetch("/api/user")
      .then((res) => res.json())
      .then(setUser);
  }, []);
  return <main>{user?.name}</main>;
}
