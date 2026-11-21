// The photo bench (/app/?diag): eight made-up photos with people (Muse Image, 21-nov), each with what must never be
// hidden (faces) and what must be (street names, house numbers, plates). Boxes are fractions of the photo's width and
// height (x, y, w, h), marked by hand on the generated photos. /bench/<name>.webp is the photo at 1280 px.

export type Box = [number, number, number, number];

export interface BenchPhoto {
  name: string;
  /** Where the photo pretends to be. */
  place: string;
  /** Faces (forehead to chin, ear to ear): no mask may touch them. */
  faces: Box[];
  /** What gives the place away and must be hidden. */
  identifiers: { what: string; box: Box }[];
}

export const BENCH: BenchPhoto[] = [
  {
    name: 'car-paris',
    place: 'a street in Paris',
    faces: [[0.645, 0.25, 0.165, 0.36]],
    identifiers: [
      { what: 'plate AB-123-CD', box: [0.33, 0.85, 0.135, 0.1] },
      { what: 'house number 27', box: [0.79, 0.11, 0.065, 0.095] },
      { what: 'BOULANGERIE MARTIN', box: [0.275, 0.135, 0.24, 0.14] },
    ],
  },
  {
    name: 'metro-london',
    place: 'Baker Street station, London',
    faces: [
      [0.29, 0.04, 0.27, 0.68],
      [0.595, 0.24, 0.065, 0.12],
      [0.665, 0.335, 0.07, 0.125],
      [0.715, 0.255, 0.05, 0.095],
    ],
    identifiers: [{ what: 'BAKER STREET roundel', box: [0.0, 0.29, 0.25, 0.125] }],
  },
  {
    name: 'selfie-lisbon',
    place: 'Rua das Flores, Lisbon',
    faces: [[0.2, 0.4, 0.53, 0.48]],
    identifiers: [{ what: 'RUA DAS FLORES', box: [0.025, 0.045, 0.47, 0.24] }],
  },
  {
    name: 'doorway-amsterdam',
    place: 'Prinsengracht, Amsterdam',
    faces: [[0.42, 0.455, 0.105, 0.1]],
    identifiers: [
      { what: 'PRINSENGRACHT', box: [0.27, 0.048, 0.22, 0.042] },
      { what: 'house number 263', box: [0.573, 0.25, 0.073, 0.037] },
    ],
  },
  {
    name: 'terrace-barcelona',
    place: 'Carrer de Verdi, Barcelona',
    faces: [
      [0.16, 0.265, 0.17, 0.32],
      [0.465, 0.27, 0.13, 0.25],
      [0.69, 0.265, 0.19, 0.35],
    ],
    identifiers: [
      { what: 'CAFE VERDI', box: [0.15, 0.12, 0.18, 0.065] },
      { what: 'Carrer de Verdi', box: [0.423, 0.005, 0.102, 0.122] },
    ],
  },
  {
    name: 'window-new-york',
    place: 'West 4th Street, New York',
    faces: [[0.465, 0.17, 0.21, 0.44]],
    identifiers: [{ what: 'W 4 St', box: [0.668, 0.03, 0.218, 0.152] }],
  },
  {
    name: 'crossing-tokyo',
    place: 'Harajuku, Tokyo',
    faces: [
      [0.07, 0.27, 0.225, 0.43],
      [0.343, 0.42, 0.14, 0.3],
      [0.532, 0.42, 0.125, 0.3],
      [0.682, 0.28, 0.112, 0.27],
    ],
    identifiers: [{ what: 'HARAJUKU STATION', box: [0.32, 0.1, 0.293, 0.068] }],
  },
  {
    name: 'park-control',
    place: 'a park anywhere (nothing should be hidden)',
    faces: [[0.4, 0.17, 0.15, 0.275]],
    identifiers: [],
  },
];
