-- AlterEnum
-- ADD VALUE roda fora de transacao (Prisma aplica esta migration isolada).
-- Separada das tabelas para evitar "unsafe use of new enum value" em PG.
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'OPERATIONS';
