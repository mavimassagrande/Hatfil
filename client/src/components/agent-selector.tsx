import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ShoppingCart, Users, Package, Truck, ClipboardList, Factory, Warehouse, FileText, Bot, Loader2 } from "lucide-react";

interface Agent {
  id: number;
  name: string;
  description: string;
  icon: string;
  category: string;
  welcomeMessage: string | null;
}

interface AgentStartResponse {
  conversation: { id: number; title: string };
  agent: Agent;
  welcomeMessage: string | null;
}

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  ShoppingCart,
  Users,
  Package,
  Truck,
  ClipboardList,
  Factory,
  Warehouse,
  FileText,
  Bot,
};

interface AgentSelectorProps {
  onAgentSelect: (conversationId: number) => void;
}

export function AgentSelector({ onAgentSelect }: AgentSelectorProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: agents = [], isLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });

  const startAgent = useMutation({
    mutationFn: async (agentId: number) => {
      const response = await apiRequest("POST", `/api/agents/${agentId}/start`);
      return response.json() as Promise<AgentStartResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      onAgentSelect(data.conversation.id);
    },
    onError: () => {
      toast({ title: "Errore", description: "Impossibile avviare l'agente", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl w-full">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <Bot className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">Nessun agente disponibile</h2>
        <p className="text-muted-foreground">
          Gli agenti verranno configurati a breve.
        </p>
      </div>
    );
  }

  const categorizedAgents = agents.reduce((acc, agent) => {
    if (!acc[agent.category]) acc[agent.category] = [];
    acc[agent.category].push(agent);
    return acc;
  }, {} as Record<string, Agent[]>);

  return (
    <div className="flex flex-col h-full p-6 overflow-auto">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold mb-2">Arke Assistant</h1>
        <p className="text-muted-foreground">Seleziona un agente per iniziare</p>
      </div>

      {Object.entries(categorizedAgents).map(([category, categoryAgents]) => (
        <div key={category} className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-muted-foreground">{category}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {categoryAgents.map((agent) => {
              const IconComponent = iconMap[agent.icon] || Bot;
              const isStarting = startAgent.isPending;
              return (
                <Card
                  key={agent.id}
                  className={`cursor-pointer hover-elevate transition-all ${isStarting ? "opacity-50 pointer-events-none" : ""}`}
                  onClick={() => !isStarting && startAgent.mutate(agent.id)}
                  data-testid={`card-agent-${agent.id}`}
                >
                  <CardHeader className="flex flex-row items-start gap-4">
                    <div className="p-2 rounded-lg bg-primary/10">
                      {isStarting ? (
                        <Loader2 className="h-6 w-6 text-primary animate-spin" />
                      ) : (
                        <IconComponent className="h-6 w-6 text-primary" />
                      )}
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <CardDescription className="text-sm mt-1">
                        {agent.description}
                      </CardDescription>
                    </div>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
