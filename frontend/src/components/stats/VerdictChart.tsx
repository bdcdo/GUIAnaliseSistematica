"use client";

import dynamic from "next/dynamic";

interface VerdictChartProps {
  data: { field: string; agreed: number; divergent: number; reviewed: number }[];
}

const VerdictChartInner = dynamic(
  () =>
    import("recharts").then((mod) => {
      const { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = mod;

      function Chart({ data }: VerdictChartProps) {
        return (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="field" tick={{ fontSize: 11 }} />
              <YAxis />
              <Tooltip />
              <Bar dataKey="agreed" fill="oklch(0.44 0.08 185)" name="Concordaram" />
              <Bar dataKey="divergent" fill="oklch(0.7 0.15 30)" name="Divergentes" />
              <Bar dataKey="reviewed" fill="oklch(0.6 0.1 250)" name="Revisados" />
            </BarChart>
          </ResponsiveContainer>
        );
      }

      return Chart;
    }),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full animate-pulse rounded bg-muted" />
    ),
  }
);

export function VerdictChart({ data }: VerdictChartProps) {
  return (
    <div className="h-80">
      <VerdictChartInner data={data} />
    </div>
  );
}
