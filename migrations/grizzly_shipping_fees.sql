-- Step 0: DB migration — run once against the main database
-- Creates the grizzly_shipping_fees table used by the carrier rate service
-- and the syncGrizzlyShippingFees.js script.

CREATE TABLE IF NOT EXISTS grizzly_shipping_fees (
    sku          VARCHAR(32)    NOT NULL,
    shipping_fee DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    ship_type    VARCHAR(64)    NULL,
    updated_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (sku)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
