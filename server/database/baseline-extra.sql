-- Drizzle does not model FTS virtual tables or cross-table constraints.
CREATE VIRTUAL TABLE IF NOT EXISTS photo_ocr_fts USING fts5(photo_id UNINDEXED, text);
--> statement-breakpoint
CREATE TRIGGER users_username_immutable BEFORE UPDATE OF username,username_key ON users
WHEN NEW.username<>OLD.username OR NEW.username_key<>OLD.username_key
BEGIN SELECT RAISE(ABORT,'Username is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER faces_partition_insert BEFORE INSERT ON asset_faces
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM photos a JOIN people p ON p.id=NEW.person_id
  WHERE a.id=NEW.photo_id AND a.ownership_type=p.ownership_type AND a.owner_id IS p.owner_id
)
BEGIN SELECT RAISE(ABORT,'Face partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER faces_partition_update BEFORE UPDATE OF person_id,photo_id ON asset_faces
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM photos a JOIN people p ON p.id=NEW.person_id
  WHERE a.id=NEW.photo_id AND a.ownership_type=p.ownership_type AND a.owner_id IS p.owner_id
)
BEGIN SELECT RAISE(ABORT,'Face partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER photos_partition_update BEFORE UPDATE OF owner_id,ownership_type ON photos
WHEN EXISTS (SELECT 1 FROM asset_faces f JOIN people p ON p.id=f.person_id
  WHERE f.photo_id=NEW.id AND (p.ownership_type<>NEW.ownership_type OR p.owner_id IS NOT NEW.owner_id))
BEGIN SELECT RAISE(ABORT,'Remove previous face associations before transferring ownership'); END;
--> statement-breakpoint
CREATE TRIGGER people_collection_insert BEFORE INSERT ON people
WHEN NEW.collection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collections c
  WHERE c.id=NEW.collection_id AND c.kind='person' AND c.ownership_type=NEW.ownership_type AND c.owner_id IS NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'Person collection partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER people_collection_update BEFORE UPDATE OF collection_id,owner_id,ownership_type ON people
WHEN (NEW.collection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collections c
  WHERE c.id=NEW.collection_id AND c.kind='person' AND c.ownership_type=NEW.ownership_type AND c.owner_id IS NEW.owner_id))
  OR EXISTS (SELECT 1 FROM asset_faces f JOIN photos a ON a.id=f.photo_id
    WHERE f.person_id=NEW.id AND (a.ownership_type<>NEW.ownership_type OR a.owner_id IS NOT NEW.owner_id))
BEGIN SELECT RAISE(ABORT,'Person partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER embedded_file_insert BEFORE INSERT ON photo_files
WHEN NEW.locator_type='embedded' AND NOT EXISTS(SELECT 1 FROM photo_files p
  WHERE p.id=NEW.parent_file_id AND p.photo_id=NEW.photo_id AND p.role='original' AND p.locator_type<>'embedded'
    AND NEW.byte_offset+NEW.byte_length<=p.byte_size)
BEGIN SELECT RAISE(ABORT,'Invalid embedded file parent or bounds'); END;
--> statement-breakpoint
CREATE TRIGGER embedded_file_update BEFORE UPDATE OF locator_type,parent_file_id,byte_offset,byte_length,photo_id ON photo_files
WHEN NEW.locator_type='embedded' AND NOT EXISTS(SELECT 1 FROM photo_files p
  WHERE p.id=NEW.parent_file_id AND p.photo_id=NEW.photo_id AND p.role='original' AND p.locator_type<>'embedded'
    AND NEW.byte_offset+NEW.byte_length<=p.byte_size)
BEGIN SELECT RAISE(ABORT,'Invalid embedded file parent or bounds'); END;
--> statement-breakpoint
CREATE TRIGGER manual_membership_insert BEFORE INSERT ON collection_photos
WHEN NOT EXISTS(SELECT 1 FROM collections c WHERE c.id=NEW.collection_id AND c.kind='manual')
BEGIN SELECT RAISE(ABORT,'Only manual albums use explicit membership'); END;
--> statement-breakpoint
CREATE TRIGGER manual_membership_added AFTER INSERT ON collection_photos
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=NEW.collection_id; END;
--> statement-breakpoint
CREATE TRIGGER manual_membership_removed AFTER DELETE ON collection_photos
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=OLD.collection_id; END;
--> statement-breakpoint
CREATE TRIGGER face_membership_added AFTER INSERT ON asset_faces WHEN NEW.person_id IS NOT NULL
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=(SELECT collection_id FROM people WHERE id=NEW.person_id); END;
--> statement-breakpoint
CREATE TRIGGER face_membership_removed AFTER DELETE ON asset_faces WHEN OLD.person_id IS NOT NULL
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=(SELECT collection_id FROM people WHERE id=OLD.person_id); END;
--> statement-breakpoint
CREATE TRIGGER face_membership_changed AFTER UPDATE OF person_id ON asset_faces WHEN NEW.person_id IS NOT OLD.person_id
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id IN(SELECT collection_id FROM people WHERE id IN(NEW.person_id,OLD.person_id)); END;
--> statement-breakpoint
CREATE TRIGGER folder_hierarchy_changed AFTER UPDATE OF parent_id,rel_path ON collections
WHEN NEW.parent_id IS NOT OLD.parent_id OR NEW.rel_path<>OLD.rel_path
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=NEW.id; END;
