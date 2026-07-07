import { describe, expect, it } from "vitest";
import { buildStateGraph } from "./build.js";
import { detectMultipleSourcesOfTruth } from "../detectors/multiple-sources.js";
import { detectUrlStateForked } from "../detectors/url-fork.js";

describe("url state adapter", () => {
  it("registers searchParams.get keys as url-param sources with reads", () => {
    const graph = buildStateGraph([
      {
        path: "src/List.tsx",
        code: `
          import { useSearchParams } from 'react-router-dom';
          export function List() {
            const [searchParams, setSearchParams] = useSearchParams();
            const filter = searchParams.get('filter');
            return <button onClick={() => setSearchParams({ page: '2' })}>{filter}</button>;
          }
        `,
      },
    ]);

    const source = graph.sources.get("url:filter");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("url-param");
    expect(source?.classification).toBe("global-client");
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/List.tsx#List",
      to: "url:filter",
      via: "hook",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "src/List.tsx#List",
      to: "url:page",
      via: "mutate",
    });
  });

  it("handles Next.js read-only useSearchParams and useParams destructures", () => {
    const graph = buildStateGraph([
      {
        path: "src/Page.tsx",
        code: `
          import { useSearchParams, useParams } from 'next/navigation';
          export function Page() {
            const searchParams = useSearchParams();
            const { slug } = useParams();
            return <div>{searchParams.get('tab')}{slug}</div>;
          }
        `,
      },
    ]);
    expect(graph.sources.get("url:tab")?.kind).toBe("url-param");
    expect(graph.sources.get("url:slug")?.kind).toBe("url-param");
  });

  it("supports nuqs useQueryState as read+write", () => {
    const graph = buildStateGraph([
      {
        path: "src/Tabs.tsx",
        code: `
          import { useQueryState } from 'nuqs';
          export function Tabs() {
            const [tab, setTab] = useQueryState('tab');
            return <button onClick={() => setTab('b')}>{tab}</button>;
          }
        `,
      },
    ]);
    expect(graph.edges).toContainEqual({
      type: "reads",
      from: "src/Tabs.tsx#Tabs",
      to: "url:tab",
      via: "hook",
    });
    expect(graph.edges).toContainEqual({
      type: "writes",
      from: "src/Tabs.tsx#Tabs",
      to: "url:tab",
      via: "mutate",
    });
  });

  it("ignores useSearchParams from non-router imports", () => {
    const graph = buildStateGraph([
      {
        path: "src/Other.tsx",
        code: `
          import { useSearchParams } from './my-lib';
          export function Other() {
            const [sp] = useSearchParams();
            return <div>{sp.get('x')}</div>;
          }
        `,
      },
    ]);
    expect(
      [...graph.sources.values()].some((s) => s.kind === "url-param"),
    ).toBe(false);
  });
});

describe("detectUrlStateForked", () => {
  it("flags useState initialized from a search param", () => {
    const graph = buildStateGraph([
      {
        path: "src/Tabs.tsx",
        code: `
          import { useSearchParams } from 'react-router-dom';
          export function Tabs() {
            const [searchParams] = useSearchParams();
            const [tab, setTab] = useState(searchParams.get('tab') ?? 'home');
            return <button onClick={() => setTab('other')}>{tab}</button>;
          }
        `,
      },
    ]);
    const findings = detectUrlStateForked(graph);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.rule).toBe("url-state-forked");
    expect(finding.message).toContain("'tab'");
    expect(finding.message).toContain("fork of the address bar");
    expect(finding.recommendation).toContain("navigating");
  });

  it("stays quiet for useState unrelated to the URL", () => {
    const graph = buildStateGraph([
      {
        path: "src/Plain.tsx",
        code: `
          import { useSearchParams } from 'react-router-dom';
          export function Plain() {
            const [searchParams] = useSearchParams();
            const [open, setOpen] = useState(false);
            return <div data-tab={searchParams.get('tab')} onClick={() => setOpen(!open)} />;
          }
        `,
      },
    ]);
    expect(detectUrlStateForked(graph)).toHaveLength(0);
  });
});

describe("multiple-sources-of-truth — URL joins the global kinds", () => {
  it("flags a zustand store competing with a URL param", () => {
    const graph = buildStateGraph([
      {
        path: "src/filterStore.ts",
        code: `
          import { create } from 'zustand';
          export const useFilterStore = create(() => ({ filter: 'all' }));
        `,
      },
      {
        path: "src/List.tsx",
        code: `
          import { useSearchParams } from 'react-router-dom';
          export function List() {
            const [searchParams] = useSearchParams();
            return <div>{searchParams.get('filter')}</div>;
          }
        `,
      },
    ]);
    const findings = detectMultipleSourcesOfTruth(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("'filter'");
    expect(findings[0]!.message).toContain("URL param 'filter'");
    expect(findings[0]!.message).toContain("useFilterStore");
  });
});
