import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  onOptionSelect?: (option: string) => void;
}

function parseOptions(content: string): { text: string; options: string[]; suggestedAnalyses: string[] } {
  const lines = content.split('\n');
  const options: string[] = [];
  const suggestedAnalyses: string[] = [];
  const textLines: string[] = [];
  
  // Check if we're in a "suggested analyses" section
  let inSuggestedSection = false;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Detect suggested analyses section header
    if (trimmedLine.toLowerCase().includes('analisi suggerit') || 
        trimmedLine.toLowerCase().includes('approfondimenti possibili') ||
        trimmedLine.toLowerCase().includes('puoi chiedermi')) {
      inSuggestedSection = true;
      textLines.push(line);
      continue;
    }
    
    const optionMatch = trimmedLine.match(/^(\d+)\.\s+(.+)$/);
    
    if (optionMatch) {
      const optionText = optionMatch[2].trim();
      // Only treat as clickable option if:
      // 1. It's short (< 60 chars) - likely a menu option, not a paragraph
      // 2. OR we're in a suggested analyses section
      // 3. AND it doesn't contain complex punctuation (sentences with multiple clauses)
      const isShortOption = optionText.length < 60;
      const hasComplexPunctuation = (optionText.match(/[,;:]/g) || []).length > 1;
      
      if (inSuggestedSection && isShortOption) {
        suggestedAnalyses.push(optionText);
      } else if (isShortOption && !hasComplexPunctuation) {
        options.push(optionText);
      } else {
        // Long observation - keep as text, not button
        textLines.push(line);
      }
    } else {
      textLines.push(line);
      // Reset section flag on empty line
      if (trimmedLine === '') inSuggestedSection = false;
    }
  }
  
  return { text: textLines.join('\n'), options, suggestedAnalyses };
}

export function ChatMessage({ role, content, isStreaming, onOptionSelect }: ChatMessageProps) {
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  
  const { text, options, suggestedAnalyses } = isAssistant && !isStreaming 
    ? parseOptions(content) 
    : { text: content, options: [], suggestedAnalyses: [] };

  return (
    <div
      className={cn(
        "flex gap-3 py-4 px-4",
        isUser ? "bg-transparent" : "bg-muted/30"
      )}
      data-testid={`message-${role}`}
    >
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className={cn(
          isUser ? "bg-primary text-primary-foreground" : "bg-sidebar text-sidebar-foreground"
        )}>
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {isUser ? "Tu" : "Assistente Arke"}
        </p>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children }) => (
                <div className="overflow-x-auto rounded-md border my-3">
                  <table className="w-full text-sm">{children}</table>
                </div>
              ),
              thead: ({ children }) => (
                <thead className="bg-muted">{children}</thead>
              ),
              th: ({ children }) => (
                <th className="px-3 py-2 text-left font-medium border-b">{children}</th>
              ),
              td: ({ children }) => (
                <td className="px-3 py-2 border-b border-border">{children}</td>
              ),
              tr: ({ children }) => (
                <tr>{children}</tr>
              ),
              code: ({ className, children, ...props }) => {
                const match = /language-(\w+)/.exec(className || "");
                const isInline = !match;
                return isInline ? (
                  <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                    {children}
                  </code>
                ) : (
                  <code className={cn("block bg-muted p-3 rounded-md overflow-x-auto text-sm font-mono", className)} {...props}>
                    {children}
                  </code>
                );
              },
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
              li: ({ children }) => <li className="mb-1">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
            }}
          >
            {text}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />
          )}
        </div>
        {options.length > 0 && onOptionSelect && (
          <div className="flex flex-wrap gap-2 pt-2">
            {options.map((option, index) => (
              <Button
                key={index}
                variant="outline"
                size="sm"
                onClick={() => onOptionSelect(option)}
                data-testid={`option-button-${index + 1}`}
              >
                {option}
              </Button>
            ))}
          </div>
        )}
        {suggestedAnalyses.length > 0 && onOptionSelect && (
          <div className="pt-3 border-t mt-3">
            <p className="text-xs text-muted-foreground mb-2">Analisi suggerite:</p>
            <div className="flex flex-wrap gap-2">
              {suggestedAnalyses.map((analysis, index) => (
                <Button
                  key={index}
                  variant="secondary"
                  size="sm"
                  onClick={() => onOptionSelect(analysis)}
                  data-testid={`suggested-analysis-${index + 1}`}
                >
                  {analysis}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
