-- How trustworthy the current automatic plate reading is (confidence, plus a bonus for
-- printed documents). A later OCR result only replaces the plate when it scores higher.
ALTER TABLE rounds ADD COLUMN plate_ocr_score REAL;
