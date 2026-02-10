import { Bot, Package, ShoppingCart, Warehouse, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface EmptyChatProps {
  onSuggestionClick: (suggestion: string) => void;
}

const suggestions = [
  {
    icon: Package,
    label: "Prodotti",
    query: "Mostrami i primi 20 prodotti nel catalogo",
  },
  {
    icon: ShoppingCart,
    label: "Ordini",
    query: "Elenca gli ordini recenti",
  },
  {
    icon: Warehouse,
    label: "Inventario",
    query: "Qual è lo stato attuale dell'inventario?",
  },
  {
    icon: Users,
    label: "Clienti",
    query: "Mostrami l'elenco dei clienti",
  },
];

export function EmptyChat({ onSuggestionClick }: EmptyChatProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-12">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-6">
        <Bot className="w-8 h-8 text-primary" />
      </div>
      <h2 className="text-2xl font-semibold mb-2">Assistente Arke</h2>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        Sono il tuo assistente per il gestionale Arke. Posso aiutarti a consultare
        prodotti, ordini, inventario e molto altro.
      </p>
      <div className="grid grid-cols-2 gap-3 w-full max-w-md">
        {suggestions.map((suggestion) => (
          <Card
            key={suggestion.label}
            className="cursor-pointer hover-elevate active-elevate-2"
            onClick={() => onSuggestionClick(suggestion.query)}
            data-testid={`button-suggestion-${suggestion.label.toLowerCase()}`}
          >
            <CardContent className="flex flex-col items-center gap-2 pt-6">
              <suggestion.icon className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm font-medium">{suggestion.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
