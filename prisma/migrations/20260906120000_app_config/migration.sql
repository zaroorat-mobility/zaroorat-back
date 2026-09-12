-- CreateEnum
CREATE TYPE "AppClient" AS ENUM ('DRIVER', 'RIDER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AppColorScheme" AS ENUM ('LIGHT', 'DARK');

-- CreateEnum
CREATE TYPE "FontSource" AS ENUM ('BUNDLED', 'GOOGLE', 'REMOTE');

-- CreateTable
CREATE TABLE "app_themes" (
    "id" UUID NOT NULL,
    "app_key" "AppClient" NOT NULL,
    "color_scheme" "AppColorScheme" NOT NULL,
    "tokens" JSONB NOT NULL,
    "components" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_fonts" (
    "id" UUID NOT NULL,
    "app_key" "AppClient" NOT NULL,
    "family" TEXT NOT NULL,
    "weight" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'normal',
    "source" "FontSource" NOT NULL DEFAULT 'BUNDLED',
    "url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_fonts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_locales" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "native_label" TEXT NOT NULL,
    "is_rtl" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_locales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_translations" (
    "id" UUID NOT NULL,
    "locale_code" TEXT NOT NULL,
    "app_key" "AppClient" NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_themes_app_key_color_scheme_key" ON "app_themes"("app_key", "color_scheme");

-- CreateIndex
CREATE INDEX "app_themes_app_key_is_active_idx" ON "app_themes"("app_key", "is_active");

-- CreateIndex
CREATE INDEX "app_fonts_app_key_is_active_idx" ON "app_fonts"("app_key", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "app_locales_code_key" ON "app_locales"("code");

-- CreateIndex
CREATE UNIQUE INDEX "app_translations_locale_code_app_key_key_key" ON "app_translations"("locale_code", "app_key", "key");

-- CreateIndex
CREATE INDEX "app_translations_locale_code_app_key_idx" ON "app_translations"("locale_code", "app_key");

-- AddForeignKey
ALTER TABLE "app_translations"
  ADD CONSTRAINT "app_translations_locale_code_fkey"
  FOREIGN KEY ("locale_code") REFERENCES "app_locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
