export function Cart() {
  const items: string[] = JSON.parse(localStorage.getItem("cart") ?? "[]");
  const addItem = (sku: string) => {
    localStorage.setItem("cart", JSON.stringify([...items, sku]));
  };
  return (
    <ul>
      {items.map((sku) => (
        <li key={sku} onClick={() => addItem(sku)}>
          {sku}
        </li>
      ))}
    </ul>
  );
}
