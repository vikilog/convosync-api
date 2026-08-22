-- User-designed tables ("Data" tab): the user defines columns with types,
-- then rows arrive by manual entry or by connecting a WhatsAppFlow so every
-- submission of that flow appends a row.

CREATE TABLE "DataTable" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataTable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataTableColumn" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataTableColumn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataTableRow" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataTableRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataTable_workspaceId_name_key" ON "DataTable"("workspaceId", "name");
CREATE INDEX "DataTable_workspaceId_idx" ON "DataTable"("workspaceId");

CREATE UNIQUE INDEX "DataTableColumn_tableId_key_key" ON "DataTableColumn"("tableId", "key");
CREATE INDEX "DataTableColumn_tableId_idx" ON "DataTableColumn"("tableId");

CREATE INDEX "DataTableRow_tableId_idx" ON "DataTableRow"("tableId");

ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataTableColumn" ADD CONSTRAINT "DataTableColumn_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DataTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataTableRow" ADD CONSTRAINT "DataTableRow_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DataTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsAppFlow" ADD COLUMN "dataTableId" TEXT;
ALTER TABLE "WhatsAppFlow" ADD COLUMN "dataTableFieldMap" JSONB;
CREATE INDEX "WhatsAppFlow_dataTableId_idx" ON "WhatsAppFlow"("dataTableId");
ALTER TABLE "WhatsAppFlow" ADD CONSTRAINT "WhatsAppFlow_dataTableId_fkey" FOREIGN KEY ("dataTableId") REFERENCES "DataTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
