import { cellToLatLng, getHexagonEdgeLengthAvg, gridDisk, isValidCell, latLngToCell } from 'h3-js';
import { geoConfig } from '@config/geo';
import { InvalidH3CellError } from '../errors/location.errors.js';
import type { Coordinate, H3Cell } from '../types/geo.types.js';
export class H3Provider {
  get resolution(): number {
    return geoConfig.h3Resolution;
  }
  cellFor(coordinate: Coordinate, resolution: number = this.resolution): H3Cell {
    return latLngToCell(coordinate.latitude, coordinate.longitude, resolution);
  }
  centerOf(cell: H3Cell): Coordinate {
    this.assertValid(cell);
    const [latitude, longitude] = cellToLatLng(cell);
    return { latitude, longitude };
  }
  neighbours(cell: H3Cell, rings = 1): H3Cell[] {
    this.assertValid(cell);
    return gridDisk(cell, Math.max(0, rings));
  }
  ringsForRadius(radiusMeters: number, resolution: number = this.resolution): number {
    const hexWidthMeters = getHexagonEdgeLengthAvg(resolution, 'm') * 2;
    if (hexWidthMeters <= 0) return 1;
    return Math.max(1, Math.ceil(radiusMeters / hexWidthMeters));
  }
  cellsCovering(
    coordinate: Coordinate,
    radiusMeters: number,
    resolution: number = this.resolution,
  ): H3Cell[] {
    const origin = this.cellFor(coordinate, resolution);
    return this.neighbours(origin, this.ringsForRadius(radiusMeters, resolution));
  }
  isValid(cell: string): boolean {
    return isValidCell(cell);
  }
  private assertValid(cell: string): void {
    if (!isValidCell(cell)) throw new InvalidH3CellError(cell);
  }
}
