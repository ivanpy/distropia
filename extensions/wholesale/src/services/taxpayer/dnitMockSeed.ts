/**
 * Demo seed of the DNIT mock (`03_sifen_y_dnit_mock.md` §2.3), keyed by the
 * normalized RUC with the corrected check digits of G-2. The status follows
 * the parity rule of the base number; the seed only supplies the names (and
 * the CIRCUITO §2 contract fields of the literal example).
 */
export interface DnitActivity {
  codigo: string;
  descripcion: string;
}

export interface DnitMockSeedEntry {
  businessName: string;
  status: 'ACTIVE' | 'BLOCKED';
  taxpayerType: 'JURIDICA' | 'FISICA';
  activities: DnitActivity[];
}

export const DNIT_MOCK_SEED: Readonly<Record<string, DnitMockSeedEntry>> = {
  '80012344-1': {
    businessName: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
    status: 'ACTIVE',
    taxpayerType: 'JURIDICA',
    activities: [
      {
        codigo: '46631',
        descripcion: 'VENTA AL POR MAYOR DE MATERIALES DE CONSTRUCCION Y HERRAMIENTAS'
      }
    ]
  },
  '80012346-8': {
    businessName: 'CONSTRUCTORA DEMO DEL ESTE S.R.L.',
    status: 'ACTIVE',
    taxpayerType: 'JURIDICA',
    activities: []
  },
  '4445551-8': {
    businessName: 'MIGUEL PEREZ FERRETERO',
    status: 'BLOCKED',
    taxpayerType: 'FISICA',
    activities: []
  }
};
