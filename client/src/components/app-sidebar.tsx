import { Plus, MessageSquare, Trash2, MoreVertical, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Conversation } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { it } from "date-fns/locale";
import { useState } from "react";

interface AppSidebarProps {
  conversations: Conversation[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onDelete: (id: number) => void;
  onRename: (id: number, title: string) => void;
  isLoading: boolean;
}

export function AppSidebar({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  isLoading,
}: AppSidebarProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const handleStartEdit = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditTitle(conv.title);
  };

  const handleSaveEdit = (id: number) => {
    if (editTitle.trim()) {
      onRename(id, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <Sidebar>
      <SidebarHeader className="p-3 border-b border-sidebar-border">
        <Button
          onClick={onCreate}
          className="w-full justify-start gap-2"
          variant="outline"
          disabled={isLoading}
          data-testid="button-new-conversation"
        >
          <Plus className="h-4 w-4" />
          Nuova conversazione
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.length === 0 ? (
                <div className="px-3 py-8 text-center text-sidebar-foreground/60 text-sm">
                  Nessuna conversazione.
                  <br />
                  Creane una nuova per iniziare.
                </div>
              ) : (
                conversations.map((conv) => (
                  <SidebarMenuItem key={conv.id}>
                    <SidebarMenuButton
                      isActive={activeId === conv.id}
                      onClick={() => onSelect(conv.id)}
                      className="w-full justify-start"
                      data-testid={`conversation-item-${conv.id}`}
                    >
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <div className="flex-1 min-w-0 text-left">
                        {editingId === conv.id ? (
                          <Input
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onBlur={() => handleSaveEdit(conv.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveEdit(conv.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            className="text-sm"
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`input-rename-${conv.id}`}
                          />
                        ) : (
                          <>
                            <p className="truncate text-sm font-medium">{conv.title}</p>
                            <p className="text-xs text-sidebar-foreground/50 truncate">
                              {formatDistanceToNow(new Date(conv.createdAt), {
                                addSuffix: true,
                                locale: it,
                              })}
                            </p>
                          </>
                        )}
                      </div>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-item:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`button-conversation-menu-${conv.id}`}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(conv);
                          }}
                          data-testid={`button-rename-${conv.id}`}
                        >
                          <Pencil className="h-4 w-4 mr-2" />
                          Rinomina
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(conv.id);
                          }}
                          className="text-destructive focus:text-destructive"
                          data-testid={`button-delete-${conv.id}`}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Elimina
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2 px-2">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span className="text-xs text-sidebar-foreground/60">Arke connesso</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
