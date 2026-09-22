import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Construction } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

export function StubToolPage({
  title,
  description,
  internalOnly,
}: {
  title: string;
  description: string;
  internalOnly?: boolean;
}) {
  // A stub is not a product. Outside internal testing (?showStubs=1) a customer
  // who reaches one by URL is sent to the dashboard instead of "Coming soon".
  const navigate = useNavigate();
  const revealed =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("showStubs") === "1";
  useEffect(() => {
    if (!revealed) navigate({ to: "/app", replace: true });
  }, [revealed, navigate]);
  if (!revealed) return null;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        {internalOnly && <Badge variant="secondary">Internal only</Badge>}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Construction className="h-4 w-4 text-orange-500" />
            Coming soon
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This tool is scaffolded. UI, AI, and database wiring land in a follow-up pass.
        </CardContent>
      </Card>
    </div>
  );
}
