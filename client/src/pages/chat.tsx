import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatMessage } from "@/components/chat-message";
import { ChatInput } from "@/components/chat-input";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bot, ArrowLeft, ShoppingCart, Package, Users, Loader2, Settings2, Palette, FileDown, Truck } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Conversation, Message, Agent } from "@shared/schema";

interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

const AGENT_ICONS: Record<string, typeof ShoppingCart> = {
  "Vendite": ShoppingCart,
  "Magazzino": Package,
  "Clienti": Users,
};

export default function ChatPage() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: agents = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });

  const { data: activeConversation, isLoading: conversationLoading } = useQuery<ConversationWithMessages>({
    queryKey: ["/api/conversations", activeConversationId],
    enabled: !!activeConversationId,
  });

  const startAgentConversation = useMutation({
    mutationFn: async (agentId: number) => {
      const response = await apiRequest("POST", `/api/agents/${agentId}/start`);
      return response.json();
    },
    onSuccess: (data: { conversation: Conversation; agent: Agent }) => {
      setActiveConversationId(data.conversation.id);
      setActiveAgent(data.agent);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", data.conversation.id] });
    },
    onError: () => {
      toast({ title: "Errore", description: "Impossibile avviare la conversazione", variant: "destructive" });
    },
  });

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [activeConversation?.messages, streamingContent, scrollToBottom]);

  const sendMessage = async (content: string) => {
    if (!activeConversationId) return;

    setIsStreaming(true);
    setStreamingContent("");

    queryClient.setQueryData<ConversationWithMessages>(
      ["/api/conversations", activeConversationId],
      (old) => {
        if (!old) return old;
        return {
          ...old,
          messages: [
            ...old.messages,
            {
              id: Date.now(),
              conversationId: activeConversationId,
              role: "user",
              content,
              createdAt: new Date(),
            },
          ],
        };
      }
    );

    try {
      const response = await fetch(`/api/conversations/${activeConversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) throw new Error("Failed to send message");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "content") {
              fullContent += event.content;
              setStreamingContent(fullContent);
            } else if (event.type === "done") {
              setIsStreaming(false);
              setStreamingContent("");
              queryClient.invalidateQueries({ queryKey: ["/api/conversations", activeConversationId] });
            } else if (event.type === "error") {
              throw new Error(event.error);
            }
          } catch (e) {
            if (!(e instanceof SyntaxError)) console.error(e);
          }
        }
      }
    } catch (error) {
      console.error("Error sending message:", error);
      toast({ title: "Errore", description: "Impossibile inviare il messaggio", variant: "destructive" });
      setIsStreaming(false);
      setStreamingContent("");
    }
  };

  const handleBackToHome = () => {
    setActiveConversationId(null);
    setActiveAgent(null);
  };

  const handleAgentSelect = (agent: Agent) => {
    startAgentConversation.mutate(agent.id);
  };

  if (!activeConversationId) {
    return (
      <div className="bg-background">
        <main className="container max-w-4xl mx-auto py-12 px-4">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-bold mb-2">Cosa vuoi fare oggi?</h2>
            <p className="text-muted-foreground">Seleziona un assistente per iniziare</p>
          </div>

          <div className="mb-8">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Assistenti AI
            </h3>
            {agentsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : agents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                Nessun assistente disponibile
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {agents.map((agent) => {
                  const IconComponent = AGENT_ICONS[agent.category || ""] || Bot;
                  return (
                    <Card
                      key={agent.id}
                      className="hover-elevate cursor-pointer transition-all"
                      onClick={() => handleAgentSelect(agent)}
                      data-testid={`agent-card-${agent.id}`}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-primary/10">
                            <IconComponent className="h-6 w-6 text-primary" />
                          </div>
                          <div>
                            <CardTitle className="text-lg">{agent.name}</CardTitle>
                            <CardDescription className="text-xs">{agent.category}</CardDescription>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {agent.description}
                        </p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mb-8">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Settings2 className="h-5 w-5" />
              Strumenti
            </h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Link href="/configurator">
                <Card
                  className="hover-elevate cursor-pointer transition-all"
                  data-testid="tool-card-configurator"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-accent">
                        <Palette className="h-6 w-6 text-accent-foreground" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">Product Configurator</CardTitle>
                        <CardDescription className="text-xs">Catalogo</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      Genera varianti prodotto combinando mastro + colore per il catalogo Arke
                    </p>
                  </CardContent>
                </Card>
              </Link>
              <Link href="/ddt-inbound">
                <Card
                  className="hover-elevate cursor-pointer transition-all"
                  data-testid="tool-card-ddt-inbound"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-accent">
                        <FileDown className="h-6 w-6 text-accent-foreground" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">DDT Inbound</CardTitle>
                        <CardDescription className="text-xs">Magazzino</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      Estrai dati da fatture PDF HATFIL e crea DDT di carico automaticamente
                    </p>
                  </CardContent>
                </Card>
              </Link>
              <Link href="/turkey-fulfillment">
                <Card
                  className="hover-elevate cursor-pointer transition-all"
                  data-testid="tool-card-turkey-fulfillment"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-accent">
                        <Truck className="h-6 w-6 text-accent-foreground" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">Evasione Rapida</CardTitle>
                        <CardDescription className="text-xs">Spedizioni</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      Evadi ordini dalla Turchia: carica giacenza e crea DDT in un click
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </div>
          </div>

          {startAgentConversation.isPending && (
            <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50">
              <div className="flex items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="text-lg">Avvio assistente...</span>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex items-center justify-between gap-2 px-4 h-14 border-b bg-background shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBackToHome}
            data-testid="button-back-home"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <h1 className="font-semibold truncate">
              {activeAgent?.name || "Arke Assistant"}
            </h1>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        {conversationLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Caricamento...</span>
            </div>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1" ref={scrollRef}>
              <div className="max-w-3xl mx-auto">
                {activeConversation?.messages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    role={message.role as "user" | "assistant"}
                    content={message.content}
                    onOptionSelect={
                      index === activeConversation.messages.length - 1 && !isStreaming
                        ? (option) => sendMessage(option)
                        : undefined
                    }
                  />
                ))}
                {isStreaming && streamingContent && (
                  <ChatMessage
                    role="assistant"
                    content={streamingContent}
                    isStreaming
                  />
                )}
                {isStreaming && !streamingContent && (
                  <div className="flex items-center gap-2 py-4 px-4 bg-muted/30">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">Elaborazione in corso...</span>
                  </div>
                )}
              </div>
            </ScrollArea>
            <ChatInput
              onSend={sendMessage}
              isLoading={isStreaming}
              disabled={!activeConversationId}
            />
          </>
        )}
      </main>
    </div>
  );
}
