import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Construction } from "lucide-react";

export function StubToolPage({
  title,
  description,
  internalOnly,
}: {
  title: string;
  description: string;
  internalOnly?: boolean;
}) {
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
