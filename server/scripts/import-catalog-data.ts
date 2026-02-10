import { db } from "../db";
import { colorFolders, colors, masterProducts } from "@shared/schema";
import { eq } from "drizzle-orm";

interface FolderDefinition {
  code: string;
  name: string;
  description: string;
}

interface ColorDefinition {
  code: string;
  name?: string;
  folderCode: string;
  stockTiers: string[];
}

interface MasterProductDefinition {
  code: string;
  name: string;
  basePrice: string;
  folderCode: string;
  stockTier: string;
}

const folderDefinitions: FolderDefinition[] = [
  { code: "GENERAL", name: "General", description: "Cartella colori principale per cotone Aegean" },
  { code: "MERCERIZED", name: "Mercerized", description: "Cartella colori per filati mercerizzati" },
  { code: "MELANGE", name: "Melange", description: "Cartella colori melange" },
  { code: "JAMIRO", name: "Jamiro/Quai", description: "Cartella colori per linea Jamiro e Quai" },
  { code: "TART", name: "Tart/Huitre", description: "Cartella colori per linea Tart e Huitre" },
  { code: "VOGUE", name: "Vogue", description: "Cartella colori per linea Vogue" },
];

function parseGeneralColors(): ColorDefinition[] {
  const allColors: string[] = [];
  for (let i = 10; i <= 1440; i += 10) {
    allColors.push(i.toString().padStart(4, "0"));
  }
  
  const stock24 = ["0040", "1440", "1090", "0980", "1430", "0600", "0630", "1370", "0380", "0190", 
                   "0160", "0860", "0690", "0220", "0970", "1100", "0490", "0250", "0370", "1280", 
                   "0950", "0340", "1130", "1400"];
  const stock12 = ["0040", "1440", "1090", "0980", "1430", "0600", "0630", "1370", "0380", "0190", "0160", "0860"];
  const stock4 = ["0040", "0980", "1090", "1440"];
  
  return allColors.map(code => {
    const stockTiers: string[] = [];
    if (stock4.includes(code)) stockTiers.push("STOCK_4");
    if (stock12.includes(code)) stockTiers.push("STOCK_12");
    if (stock24.includes(code)) stockTiers.push("STOCK_24");
    stockTiers.push("STOCK_144");
    
    return { code, folderCode: "GENERAL", stockTiers };
  });
}

function parseMercerizedColors(): ColorDefinition[] {
  const allColors: string[] = [];
  for (let i = 6010; i <= 6725; i += 5) {
    allColors.push(i.toString());
  }
  
  const stock24 = ["6015", "6085", "6495", "6190", "6130", "6350", "6115", "6320", "6450", "6100", 
                   "6175", "6250", "6305", "6690", "6550", "6705", "6555", "6645", "6195", "6720", 
                   "6725", "6480", "6570", "6490"];
  const stock12 = ["6015", "6085", "6495", "6190", "6130", "6350", "6115", "6320", "6450", "6100", "6175", "6250"];
  const stock4 = ["6015", "6085", "6495", "6190"];
  
  return allColors.map(code => {
    const stockTiers: string[] = [];
    if (stock4.includes(code)) stockTiers.push("STOCK_4");
    if (stock12.includes(code)) stockTiers.push("STOCK_12");
    if (stock24.includes(code)) stockTiers.push("STOCK_24");
    stockTiers.push("STOCK_144");
    
    return { code, folderCode: "MERCERIZED", stockTiers };
  });
}

function parseJamiroColors(): ColorDefinition[] {
  const allCodes = [
    "JQ0005", "JQ0010", "JQ0015", "JQ0020", "JQ0025", "JQ0030", "JQ0035", "JQ0040", 
    "JQ0045", "JQ0050", "JQ0055", "JQ0060", "JQ0065", "JQ0070", "JQ0075", "JQ0080", 
    "JQ0085", "JQ0090", "JQ0095", "JQ0100", "JQ0105", "JQ0110", "JQ0115", "JQ0120"
  ];
  const stock4 = ["JQ0005", "JQ0010", "JQ0105", "JQ0075"];
  
  return allCodes.map(code => ({
    code,
    folderCode: "JAMIRO",
    stockTiers: stock4.includes(code) ? ["STOCK_4", "STOCK_12"] : ["STOCK_12"]
  }));
}

function parseTartColors(): ColorDefinition[] {
  const allCodes = [
    "TH0005", "TH0010", "TH0015", "TH0020", "TH0025", "TH0030", "TH0035", "TH0040", 
    "TH0045", "TH0050", "TH0055", "TH0060", "TH0065", "TH0070", "TH0075", "TH0080", 
    "TH0085", "TH0090", "TH0095", "TH0100", "TH0105", "TH0110", "TH0115", "TH0120"
  ];
  const stock4 = ["TH0005", "TH0010", "TH0105", "TH0075"];
  
  return allCodes.map(code => ({
    code,
    folderCode: "TART",
    stockTiers: stock4.includes(code) ? ["STOCK_4", "STOCK_12"] : ["STOCK_12"]
  }));
}

function parseVogueColors(): ColorDefinition[] {
  const allCodes = [
    "V0005", "V0010", "V0015", "V0020", "V0025", "V0030", "V0035", "V0040", 
    "V0045", "V0050", "V0055", "V0060", "V0065", "V0070", "V0075", "V0080", 
    "V0085", "V0090", "V0095", "V0100", "V0105", "V0110", "V0115", "V0120"
  ];
  const stock4 = ["V0005", "V0010", "V0075", "V0105"];
  
  return allCodes.map(code => ({
    code,
    folderCode: "VOGUE",
    stockTiers: stock4.includes(code) ? ["STOCK_4", "STOCK_12"] : ["STOCK_12"]
  }));
}

function parseMelangeColors(): ColorDefinition[] {
  const melangeColors = [
    { code: "600", name: "BLU CH" },
    { code: "610", name: "BLU ME" },
    { code: "620", name: "BLU SC" },
    { code: "630", name: "BLU SC+" },
    { code: "640", name: "GRIGIO CH" },
    { code: "650", name: "GRIGIO ME" },
    { code: "660", name: "GRIGIO SC" },
    { code: "670", name: "GRIGIO SC+" },
    { code: "680", name: "BEIGE" },
    { code: "690", name: "BEIGE ME" },
    { code: "700", name: "BEIGE SC" },
    { code: "710", name: "BEIGE SC+" },
  ];
  
  return melangeColors.map(c => ({
    code: c.code,
    name: c.name,
    folderCode: "MELANGE",
    stockTiers: ["STOCK_12"]
  }));
}

const masterProductData: MasterProductDefinition[] = [
  { code: "BOLD 3", name: "NM 3/5 100% AEGEAN COTTON GOTS LS", basePrice: "17.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "BOLD MELANGE 3", name: "NM 3/5 100% AEGEAN COTTON GOTS", basePrice: "18.0", folderCode: "MELANGE", stockTier: "STOCK_12" },
  { code: "BOLD 5", name: "NM 2/5 100% AEGEAN COTTON GOTS LS", basePrice: "17.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "BOLD MELANGE 5", name: "NM 2/5 100% AEGEAN COTTON GOTS LS", basePrice: "18.0", folderCode: "MELANGE", stockTier: "STOCK_12" },
  { code: "SAGE 7", name: "NM 5/34 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "15.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "SAGE 12", name: "NM 2/34 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "15.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "SAGE 12 GLOSS", name: "NM 2/36 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "18.0", folderCode: "MERCERIZED", stockTier: "STOCK_12" },
  { code: "PARSLEY 14", name: "NM 2/50 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "16.0", folderCode: "GENERAL", stockTier: "STOCK_144" },
  { code: "PARSLEY 14 GLOSS", name: "NM 2/54 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "19.0", folderCode: "MERCERIZED", stockTier: "STOCK_144" },
  { code: "PARSLEY 14 MELANGE", name: "NM 2/50 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "16.0", folderCode: "MELANGE", stockTier: "STOCK_12" },
  { code: "PARSLEY 12", name: "NM 3/50 100% AEGEANCOTTON COMPACT GOTS LS", basePrice: "16.0", folderCode: "GENERAL", stockTier: "STOCK_24" },
  { code: "PARSLEY 12 GLOSS", name: "NM 3/54 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "19.0", folderCode: "MERCERIZED", stockTier: "STOCK_24" },
  { code: "PARSLEY 12 MELANGE", name: "NM 3/50 100% AEGEAN COTTON GOTS LS", basePrice: "16.0", folderCode: "MELANGE", stockTier: "STOCK_12" },
  { code: "PARSLEY 7", name: "NM 8/50 100% COTTON AEGEAN COMPACT GOTS LS", basePrice: "16.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "PARSLEY 7 MELANGE", name: "NM 8/50 100% AEGEAN COTTON LS", basePrice: "16.0", folderCode: "MELANGE", stockTier: "STOCK_12" },
  { code: "PARSLEY CORD 4200", name: "NM 2/50X6 100% AEGEAN COTTON COMPACT LS", basePrice: "17.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "PARSLEY CORD 4200 GLOSS", name: "NM 2/54X6 100% AEGEAN COTTON COMPACT GOTS GASSED MERCERIZED LS", basePrice: "20.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "PARSLEY CORD 1100 GLOSS", name: "NM 1100 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "20.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "SLICK 12", name: "NM 4/68 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "17.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "SLICK 14", name: "NM 3/68 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "17.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "SLICK 18", name: "NM 2/68 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "17.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "LEGGERO 12", name: "NM 5/100 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "20.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "LEGGERO 12 DRY", name: "NM 5/100 100% AEGEAN COTTON GOTS GASSED LS", basePrice: "21.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO 14", name: "NM 4/100 100% AEGEAN COTTON COMPACT GOTS LS", basePrice: "20.0", folderCode: "GENERAL", stockTier: "STOCK_24" },
  { code: "LEGGERO 14 DRY", name: "NM 4/100 100% AEGEAN COTTON GOTS GASSED LS", basePrice: "21.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO 14 GLOSS", name: "NM 3/105 100% AEGEAN COTTON GOTS GASSED MERCERISED LS", basePrice: "23.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "LEGGERO 18", name: "NM 3/100 100% AEGEAN COTTON GOTS LS", basePrice: "20.0", folderCode: "GENERAL", stockTier: "STOCK_24" },
  { code: "LEGGERO 18 DRY", name: "NM 3/100 100% AEGEAN COTTON GOTS GASSED LS", basePrice: "21.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO 18 GLOSS", name: "NM 3/105 100% AEGEAN COTTON GOTS GASSED MERCERISED LS", basePrice: "23.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "LEGGERO 21", name: "NM 2/100 100% AEGEAN COTTON GOTS LS", basePrice: "20.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO 21 GLOSS", name: "NM 2/105 100% AEGEAN COTTON GOTS GASSED MERCERISED LS", basePrice: "23.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 2000", name: "NM 2000 100% AEGEAN COTTON GOTS LS", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 2000 GLOSS", name: "NM 2000 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "26.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 2400", name: "NM 2400 100% AEGEAN COTTON GOTS LS", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 2400 GLOSS", name: "NM 2400 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "26.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 3200", name: "NM 3200 100% AEGEAN COTTON GOTS LS", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 3200 GLOSS", name: "NM 3200 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "26.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "LEGGERO TAPE 3800", name: "NM 3800 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MOSSO TAPE 3200", name: "NM 3200 100% AEGEAN COTTON GOTS GASSED MERCERIZED LS", basePrice: "20.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "SUZETTE 12", name: "NM 3/50 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "17.5", folderCode: "GENERAL", stockTier: "STOCK_24" },
  { code: "SUZETTE 12 DRY", name: "NM 3/50 100% COTTON AEGEAN GOTS GASSED CREPE LS", basePrice: "18.5", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "SUZETTE 14", name: "NM 2/50 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "17.5", folderCode: "GENERAL", stockTier: "STOCK_24" },
  { code: "SUZETTE 14 DRY", name: "NM 2/50 100% COTTON AEGEAN GOTS GASSED CREPE LS", basePrice: "18.5", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "CRISP 12", name: "NM 5/100 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "22.5", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "CRISP 14", name: "NM 4/100 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "22.5", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "CRISP 18", name: "NM 3/100 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "22.5", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "CRISP 21", name: "NM 2/100 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "22.5", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "CRISP CORD 8000", name: "NM 2/100X2X3 100% COTTON AEGEAN GOTS CREPE LS", basePrice: "25.5", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "BREEZE 14 GLOSS", name: "NM 2/88X2 100% PIMA GASSED MERCERIZED CREPE LS", basePrice: "24.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "BEURRE 12", name: "NM 3/50 100% PIMA COTTON GOTS ELS", basePrice: "29.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "BEURRE 14", name: "NM 2/50 100% PIMA COTTON GOTS ELS", basePrice: "29.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "BEURRE 14 GLOSS", name: "NM 2/54 100% PIMA COTTON GOTS GASSED MERCERIZED ELS", basePrice: "32.0", folderCode: "MERCERIZED", stockTier: "STOCK_12" },
  { code: "BEURRE 7", name: "NM 8/50 100% PIMA COTTON GOTS ELS", basePrice: "29.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "BEURRE CORD 6500 GLOSS", name: "NM 2/54X4 100% PIMA COTTON GOTS GASSED MERCERIZED ELS", basePrice: "34.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "BAGUETTE 14", name: "NM 4/100 100% PIMA COTTON GOTS ELS", basePrice: "31.0", folderCode: "GENERAL", stockTier: "STOCK_24" },
  { code: "BAGUETTE 14 GLOSS", name: "NM 4/105 100% PIMA COTTON GOTS GASSED MERCERIZED ELS", basePrice: "34.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "BAGUETTE 14 CREPE", name: "NM 4/100 100% PIMA COTTON GOTS GASSED CREPE ELS", basePrice: "33.5", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "BAGUETTE CORD 17500 GLOSS", name: "NM 2/105X3 100% PIMA COTTON GOTS GASSED MERCERIZED ELS", basePrice: "36.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "BAGUETTE 18", name: "NM 3/100 100% PIMA COTTON GOTS ELS", basePrice: "31.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "BAGUETTE 21", name: "NM 2/100 100% PIMA COTTON GOTS ELS", basePrice: "31.0", folderCode: "GENERAL", stockTier: "STOCK_12" },
  { code: "BAGUETTE 21 GLOSS", name: "NM 2/105 100% PIMA COTTON GOTS GASSED MERCERIZED ELS", basePrice: "34.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "CHIC 18", name: "NM 4/135 100% PIMA COTTON BCI ELS", basePrice: "27.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "CHIC 21", name: "NM 2/135 100% PIMA COTTON BCI ELS", basePrice: "27.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MOSSO 14", name: "NM 2/50 AEGEAN COTTON GOTS SLUB LS", basePrice: "19.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MOSSO LINO 12", name: "NM 17000 66% LINEN 34% AEGEAN COTTON GOTS LS", basePrice: "29.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MAPLE 14", name: "NM 2/50 50% AEGEAN COTTON GOTS LS 50% MODAL FSC", basePrice: "16.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MASH 12", name: "NM 3/50 80% MICROMODAL 10% POLYAMIDE 10% CASHMERE", basePrice: "29.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MASH 14", name: "NM 2/50 80% MICROMODAL 10% POLYAMIDE 10% CASHMERE", basePrice: "29.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "FLEXE 14", name: "NM 2/85 95% AEGEAN COTTON GOTS LS 5% ELASTAN", basePrice: "24.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "CHURRO 7000", name: "NM 6/50 100% COTTON VORTEX GRS", basePrice: "18.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MOUSSE 5", name: "NM 2/34X7 100% VISCOSE ECOVERO", basePrice: "19.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "MERINGUE 12", name: "NM 3/50 50% COTTON 40% VISCOSE 10% LINEN", basePrice: "19.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "MERINGUE 14", name: "NM 2/50 50% COTTON 40% VISCOSE 10% LINEN", basePrice: "19.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "GRATIN 14", name: "NM 2/50 70% AEGEAN COTTON GOTS LS 30% LINEN", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "RATATOUILLE", name: "NM 2/50 70% AEGEAN COTTON 20% LINEN 10% SILK", basePrice: "28.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "SATINÉE 12", name: "NM 14000 60% AEGEAN COTTON GOTS 40% VISCOSE ECOVERO", basePrice: "27.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
  { code: "JAMIRO 14", name: "NM 2/50 85% AEGEAN COTTON GOTS LS 15% CASHMERE", basePrice: "39.0", folderCode: "JAMIRO", stockTier: "STOCK_12" },
  { code: "JAMIRO 12", name: "NM 3/50 85% AEGEAN COTTON GOTS LS 15% CASHMERE", basePrice: "39.0", folderCode: "JAMIRO", stockTier: "STOCK_12" },
  { code: "QUAI 14", name: "NM 2/50 90% AEGEAN COTTON GOTS LS 10% CASHMERE", basePrice: "33.0", folderCode: "JAMIRO", stockTier: "STOCK_12" },
  { code: "QUAI CORD 3", name: "NM 2/50X10 85% AEGEAN COTTON GOTS LS 15% CASHMERE", basePrice: "35.0", folderCode: "JAMIRO", stockTier: "STOCK_4" },
  { code: "WHISPER 14", name: "NM 2/50 70% AEGEAN COTTON GOTS LS 30% EXTRAFINE WOOL RWS", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "WHISPER 12", name: "NM 3/50 70% AEGEAN COTTON GOTS LS 30% EXTRAFINE WOOL RWS", basePrice: "23.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "TART 18", name: "NM 2/60 80% PIMA COTTON ELS 10% CASHMERE 10% SILK MULBERRY", basePrice: "57.0", folderCode: "TART", stockTier: "STOCK_4" },
  { code: "TART 7", name: "NM 2/60X4 80% PIMA COTTON ELS 10% CASHMERE 10% SILK MULBERRY", basePrice: "59.0", folderCode: "TART", stockTier: "STOCK_4" },
  { code: "HUITRE 14", name: "NM 2/50 70% PIMA COTTON ELS 15% CASHMERE 15% SILK MULBERRY", basePrice: "64.0", folderCode: "TART", stockTier: "STOCK_4" },
  { code: "HUITRE CORD 3", name: "NM 2/50X12 70% PIMA COTTON ELS 15% CASHMERE 15% SILK MULBERRY", basePrice: "66.0", folderCode: "TART", stockTier: "STOCK_4" },
  { code: "VOGUE 14", name: "NM 2/50 70% PIMA COTTON ELS 30% SILK MULBERRY", basePrice: "59.0", folderCode: "VOGUE", stockTier: "STOCK_4" },
  { code: "VOGUE 18", name: "NM 2/68 70% PIMA COTTON ELS 30% SILK MULBERRY", basePrice: "64.0", folderCode: "VOGUE", stockTier: "STOCK_4" },
  { code: "VOGUE TAPE 3", name: "NM 3500 70% PIMA COTTON ELS 30% SILK MULBERRY", basePrice: "69.0", folderCode: "VOGUE", stockTier: "STOCK_4" },
  { code: "ETNEO 3", name: "NM 4/10 100% AEGEAN COTTON GOTS GASSED MERCERIZED GOTS LS", basePrice: "19.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "ETNEO 3 PRINTED", name: "NM 4/10 100% AEGEAN COTTON GOTS GASSED MERCERIZED GOTS LS", basePrice: "26.0", folderCode: "GENERAL", stockTier: "STOCK_4" },
  { code: "PARSLEY CORD 2100 GLOSS", name: "NM 2/50*12 100% AEGEAN COTTON GASSED MERCERIZED GOTS LS", basePrice: "20.0", folderCode: "MERCERIZED", stockTier: "STOCK_4" },
];

export async function importCatalogData() {
  console.log("Starting catalog data import...");
  
  console.log("1. Creating color folders...");
  const folderMap = new Map<string, number>();
  for (const folder of folderDefinitions) {
    const existing = await db.select().from(colorFolders).where(eq(colorFolders.code, folder.code));
    if (existing.length > 0) {
      folderMap.set(folder.code, existing[0].id);
      console.log(`  - Folder ${folder.code} already exists`);
    } else {
      const [inserted] = await db.insert(colorFolders).values(folder).returning();
      folderMap.set(folder.code, inserted.id);
      console.log(`  - Created folder ${folder.code}`);
    }
  }
  
  console.log("2. Importing colors...");
  const allColors: ColorDefinition[] = [
    ...parseGeneralColors(),
    ...parseMercerizedColors(),
    ...parseJamiroColors(),
    ...parseTartColors(),
    ...parseVogueColors(),
    ...parseMelangeColors(),
  ];
  
  let colorCount = 0;
  for (const color of allColors) {
    const folderId = folderMap.get(color.folderCode);
    if (!folderId) {
      console.log(`  - Skipping color ${color.code}: folder ${color.folderCode} not found`);
      continue;
    }
    
    const existing = await db.select().from(colors)
      .where(eq(colors.code, color.code));
    
    const colorInFolder = existing.find(c => c.folderId === folderId);
    if (!colorInFolder) {
      await db.insert(colors).values({
        code: color.code,
        name: color.name || null,
        folderId,
        stockTiers: color.stockTiers,
      });
      colorCount++;
    }
  }
  console.log(`  - Imported ${colorCount} colors`);
  
  console.log("3. Importing master products...");
  let productCount = 0;
  for (const product of masterProductData) {
    const folderId = folderMap.get(product.folderCode);
    if (!folderId) {
      console.log(`  - Skipping product ${product.code}: folder ${product.folderCode} not found`);
      continue;
    }
    
    const existing = await db.select().from(masterProducts).where(eq(masterProducts.code, product.code));
    if (existing.length === 0) {
      await db.insert(masterProducts).values({
        code: product.code,
        name: product.name,
        basePrice: product.basePrice,
        folderId,
        stockTier: product.stockTier,
        uom: "kilogram",
        category: "evolution",
      });
      productCount++;
    }
  }
  console.log(`  - Imported ${productCount} master products`);
  
  console.log("Import completed!");
  return { folders: folderMap.size, colors: colorCount, products: productCount };
}
