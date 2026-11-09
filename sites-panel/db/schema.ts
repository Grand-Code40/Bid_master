// Input for the supported Sites/Drizzle generator. Not executed yet.
import {sqliteTable,text,integer,primaryKey,foreignKey,check,index,uniqueIndex} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';
export const listings=sqliteTable('listings',{
 ownerId:text('owner_id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 data:text('data').notNull(),fieldTimes:text('field_times').notNull().default('{}'),
 firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull(),storageVersion:integer('storage_version').notNull().default(1),
},t=>[primaryKey({columns:[t.ownerId,t.sourceId,t.externalId]}),check('listings_data_json',sql`json_valid(${t.data})`)]);
export const reviews=sqliteTable('reviews',{
 ownerId:text('owner_id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 data:text('data').notNull(),storageVersion:integer('storage_version').notNull().default(1),lastOperation:text('last_operation').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.sourceId,t.externalId]}),check('reviews_data_json',sql`json_valid(${t.data})`),foreignKey({columns:[t.ownerId,t.sourceId,t.externalId],foreignColumns:[listings.ownerId,listings.sourceId,listings.externalId]})]);
export const reviewEvents=sqliteTable('review_events',{
 ownerId:text('owner_id').notNull(),operationId:text('operation_id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 action:text('action').notNull(),at:text('at').notNull(),data:text('data').notNull(),requestHash:text('request_hash').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.operationId]}),check('review_events_data_json',sql`json_valid(${t.data})`)]);

// Additive check journal; no foreign keys or writes to legacy tables.
export const scanRuns=sqliteTable('scan_runs',{
 ownerId:text('owner_id').notNull(),runId:text('run_id').notNull(),sourceId:text('source_id').notNull(),
 checkedAt:text('checked_at').notNull(),recordedAt:text('recorded_at').notNull(),data:text('data').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.runId,t.sourceId]}),check('scan_runs_data_json',sql`json_valid(${t.data})`),index('scan_runs_latest').on(t.ownerId,t.sourceId,t.checkedAt,t.recordedAt,t.runId)]);

// Additive, immutable observed emails. Viewed status is local to this panel.
export const mailNotifications=sqliteTable('mail_notifications',{
 ownerId:text('owner_id').notNull(),mailbox:text('mailbox').notNull(),messageId:text('message_id').notNull(),
 receivedAt:text('received_at').notNull(),recordedAt:text('recorded_at').notNull(),data:text('data').notNull(),
 sourceId:text('source_id'),externalId:text('external_id'),linkStatus:text('link_status').notNull(),panelViewedAt:text('panel_viewed_at'),
},t=>[primaryKey({columns:[t.ownerId,t.mailbox,t.messageId]}),check('mail_data_json',sql`json_valid(${t.data})`),check('mail_link_status',sql`${t.linkStatus} IN ('exact_url','unresolved','unlinked')`),check('mail_link_pair',sql`(${t.sourceId} IS NULL AND ${t.externalId} IS NULL AND ${t.linkStatus}!='exact_url') OR (${t.sourceId} IS NOT NULL AND ${t.externalId} IS NOT NULL AND ${t.linkStatus}='exact_url')`),index('mail_notifications_recent').on(t.ownerId,t.receivedAt,t.mailbox,t.messageId)]);

// Accounting projection and immutable audit, independent of review history.
export const deliveryRecords=sqliteTable('delivery_records',{
 ownerId:text('owner_id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 version:integer('version').notNull(),data:text('data').notNull(),lastOperation:text('last_operation').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.sourceId,t.externalId]}),check('delivery_records_data_json',sql`json_valid(${t.data})`)]);
export const deliveryEvents=sqliteTable('delivery_events',{
 ownerId:text('owner_id').notNull(),operationId:text('operation_id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 version:integer('version').notNull(),action:text('action').notNull(),at:text('at').notNull(),data:text('data').notNull(),requestHash:text('request_hash').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.operationId]}),check('delivery_events_data_json',sql`json_valid(${t.data})`),uniqueIndex('delivery_events_version').on(t.ownerId,t.sourceId,t.externalId,t.version)]);


// Additive preflight and durable one-attempt delivery records.
export const deliveryPreflights=sqliteTable('delivery_preflights',{
 ownerId:text('owner_id').notNull(),id:text('id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 revision:integer('revision').notNull(),storageVersion:integer('storage_version').notNull(),data:text('data').notNull(),expiresAt:text('expires_at').notNull(),usedBy:text('used_by'),createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.id]}),check('delivery_preflights_data_json',sql`json_valid(${t.data})`)]);
export const deliveryAttempts=sqliteTable('delivery_attempts',{
 ownerId:text('owner_id').notNull(),operationId:text('operation_id').notNull(),sourceId:text('source_id').notNull(),externalId:text('external_id').notNull(),
 revision:integer('revision').notNull(),preflightId:text('preflight_id').notNull(),requestHash:text('request_hash').notNull(),data:text('data').notNull(),
},t=>[primaryKey({columns:[t.ownerId,t.operationId]}),check('delivery_attempts_data_json',sql`json_valid(${t.data})`),uniqueIndex('delivery_attempt_order_revision').on(t.ownerId,t.sourceId,t.externalId,t.revision),uniqueIndex('delivery_attempt_preflight').on(t.ownerId,t.preflightId)]);
export {platformMessages,inboxSyncState,mailProviderProvenance} from './inbox-schema';
