import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull(),
  category: text("category").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  tools: text("tools").array().notNull(),
  welcomeMessage: text("welcome_message"),
  isActive: integer("is_active").default(1).notNull(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true });
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  agentId: integer("agent_id").references(() => agents.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export const orderDrafts = pgTable("order_drafts", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }).unique(),
  wizardStep: text("wizard_step").default("CLIENTE").notNull(),
  customerId: text("customer_id"),
  customerName: text("customer_name"),
  customerData: jsonb("customer_data"),
  products: jsonb("products").default([]),
  shippingAddress: text("shipping_address"),
  expectedShippingTime: text("expected_shipping_time"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertOrderDraftSchema = createInsertSchema(orderDrafts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type OrderDraft = typeof orderDrafts.$inferSelect;
export type InsertOrderDraft = z.infer<typeof insertOrderDraftSchema>;

// ==================== PRODUCT CONFIGURATOR ====================

export const colorFolders = pgTable("color_folders", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
});

export const colorFoldersRelations = relations(colorFolders, ({ many }) => ({
  colors: many(colors),
  masterProducts: many(masterProducts),
}));

export const insertColorFolderSchema = createInsertSchema(colorFolders).omit({ id: true });
export type ColorFolder = typeof colorFolders.$inferSelect;
export type InsertColorFolder = z.infer<typeof insertColorFolderSchema>;

export const colors = pgTable("colors", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name"),
  folderId: integer("folder_id").notNull().references(() => colorFolders.id),
  stockTiers: text("stock_tiers").array().default([]),
});

export const colorsRelations = relations(colors, ({ one }) => ({
  folder: one(colorFolders, {
    fields: [colors.folderId],
    references: [colorFolders.id],
  }),
}));

export const insertColorSchema = createInsertSchema(colors).omit({ id: true });
export type Color = typeof colors.$inferSelect;
export type InsertColor = z.infer<typeof insertColorSchema>;

export const masterProducts = pgTable("master_products", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(),
  uom: text("uom").default("kilogram").notNull(),
  folderId: integer("folder_id").notNull().references(() => colorFolders.id),
  stockTier: text("stock_tier").notNull(),
  category: text("category").default("evolution").notNull(),
});

export const masterProductsRelations = relations(masterProducts, ({ one, many }) => ({
  folder: one(colorFolders, {
    fields: [masterProducts.folderId],
    references: [colorFolders.id],
  }),
  generatedProducts: many(generatedProducts),
}));

export const insertMasterProductSchema = createInsertSchema(masterProducts).omit({ id: true });
export type MasterProduct = typeof masterProducts.$inferSelect;
export type InsertMasterProduct = z.infer<typeof insertMasterProductSchema>;

export const generatedProducts = pgTable("generated_products", {
  id: serial("id").primaryKey(),
  masterProductId: integer("master_product_id").notNull().references(() => masterProducts.id),
  colorId: integer("color_id").notNull().references(() => colors.id),
  arkeProductId: text("arke_product_id"),
  arkeInternalId: text("arke_internal_id").notNull().unique(),
  syncStatus: text("sync_status").default("pending").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const generatedProductsRelations = relations(generatedProducts, ({ one }) => ({
  masterProduct: one(masterProducts, {
    fields: [generatedProducts.masterProductId],
    references: [masterProducts.id],
  }),
  color: one(colors, {
    fields: [generatedProducts.colorId],
    references: [colors.id],
  }),
}));

export const insertGeneratedProductSchema = createInsertSchema(generatedProducts).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true 
});
export type GeneratedProduct = typeof generatedProducts.$inferSelect;
export type InsertGeneratedProduct = z.infer<typeof insertGeneratedProductSchema>;

// Custom colors for client-specific requests
export const customColors = pgTable("custom_colors", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name"),
  customerId: text("customer_id").notNull(),
  customerName: text("customer_name").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertCustomColorSchema = createInsertSchema(customColors).omit({ id: true, createdAt: true });
export type CustomColor = typeof customColors.$inferSelect;
export type InsertCustomColor = z.infer<typeof insertCustomColorSchema>;
