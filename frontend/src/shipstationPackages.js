/**
 * Hardcoded ShipStation package catalog.
 * `code` is the exact ShipStation packageCode for the API.
 * `dims` is { l, w, h } in inches — null means dimensions are not fixed.
 * `requiresDims` means the user MUST enter custom dimensions.
 * `carrier` is null for the shared generic "package" code (works with any carrier).
 */

export const SS_PACKAGES = [
  // ── Generic (any carrier) ────────────────────────────────────────────────────
  { carrier: null, code: 'package',                   label: 'Package',                   dims: null,                             requiresDims: true  },

  // ── USPS ────────────────────────────────────────────────────────────────────
  { carrier: 'USPS', code: 'large_flat_rate_box',       label: 'Large Flat Rate Box',        dims: { l: 12.25, w: 12.25, h: 6     }                    },
  { carrier: 'USPS', code: 'medium_flat_rate_box',      label: 'Medium Flat Rate Box',       dims: { l: 11.25, w: 8.75,  h: 6     }                    },
  { carrier: 'USPS', code: 'small_flat_rate_box',       label: 'Small Flat Rate Box',        dims: { l: 8.69,  w: 5.44,  h: 1.75  }                    },
  { carrier: 'USPS', code: 'flat_rate_envelope',        label: 'Flat Rate Envelope',         dims: { l: 12.5,  w: 9.5,   h: 0.25  }                    },
  { carrier: 'USPS', code: 'flat_rate_padded_envelope', label: 'Flat Rate Padded Envelope',  dims: { l: 12.5,  w: 9.5,   h: 1     }                    },
  { carrier: 'USPS', code: 'flat_rate_legal_envelope',  label: 'Flat Rate Legal Envelope',   dims: { l: 15,    w: 9.5,   h: 0.25  }                    },
  { carrier: 'USPS', code: 'regional_rate_box_a',       label: 'Regional Rate Box A',        dims: { l: 10.13, w: 7.13,  h: 5     }                    },
  { carrier: 'USPS', code: 'regional_rate_box_b',       label: 'Regional Rate Box B',        dims: { l: 12.25, w: 10.5,  h: 5.5   }                    },
  { carrier: 'USPS', code: 'large_envelope_or_flat',    label: 'Large Envelope or Flat',     dims: null,                             requiresDims: true  },
  { carrier: 'USPS', code: 'postcard',                  label: 'Postcard',                   dims: { l: 6,     w: 4.25,  h: 0.016 }                    },
  { carrier: 'USPS', code: 'letter',                    label: 'Letter',                     dims: { l: 11.5,  w: 6.125, h: 0.25  }                    },

  // ── FedEx ───────────────────────────────────────────────────────────────────
  { carrier: 'FedEx', code: 'fedex_envelope',           label: 'FedEx Envelope',             dims: { l: 12.5,  w: 9.5,   h: 0.25  }                    },
  { carrier: 'FedEx', code: 'fedex_pak',                label: 'FedEx Pak',                  dims: { l: 15.5,  w: 12,    h: 0.5   }                    },
  { carrier: 'FedEx', code: 'fedex_box',                label: 'FedEx Box',                  dims: null,                             requiresDims: true  },
  { carrier: 'FedEx', code: 'fedex_tube',               label: 'FedEx Tube',                 dims: { l: 38,    w: 6,     h: 6     }                    },
  { carrier: 'FedEx', code: 'fedex_small_box',          label: 'FedEx Small Box',            dims: { l: 10.88, w: 12.38, h: 1.5   }                    },
  { carrier: 'FedEx', code: 'fedex_medium_box',         label: 'FedEx Medium Box',           dims: { l: 11.5,  w: 13.25, h: 2.38  }                    },
  { carrier: 'FedEx', code: 'fedex_large_box',          label: 'FedEx Large Box',            dims: { l: 12.38, w: 17.5,  h: 3     }                    },
  { carrier: 'FedEx', code: 'fedex_extra_large_box',    label: 'FedEx Extra Large Box',      dims: { l: 15.75, w: 21.5,  h: 4.13  }                    },
  { carrier: 'FedEx', code: 'fedex_10_kg_box',          label: 'FedEx 10 kg Box',            dims: { l: 15.81, w: 12.94, h: 10.19 }                    },
  { carrier: 'FedEx', code: 'fedex_25_kg_box',          label: 'FedEx 25 kg Box',            dims: { l: 21.56, w: 16.56, h: 13.19 }                    },

  // ── UPS ─────────────────────────────────────────────────────────────────────
  { carrier: 'UPS', code: 'ups_letter',                 label: 'UPS Letter',                 dims: { l: 15.5,  w: 12,    h: 0.25  }                    },
  { carrier: 'UPS', code: 'ups_pak',                    label: 'UPS Pak',                    dims: { l: 16,    w: 12.75, h: 0.5   }                    },
  { carrier: 'UPS', code: 'ups_tube',                   label: 'UPS Tube',                   dims: { l: 38,    w: 6,     h: 6     }                    },
  { carrier: 'UPS', code: 'ups_express_box_small',      label: 'UPS Express Box Small',      dims: { l: 13,    w: 11,    h: 2     }                    },
  { carrier: 'UPS', code: 'ups_express_box_medium',     label: 'UPS Express Box Medium',     dims: { l: 15,    w: 11,    h: 3     }                    },
  { carrier: 'UPS', code: 'ups_express_box_large',      label: 'UPS Express Box Large',      dims: { l: 18,    w: 13,    h: 3     }                    },
  { carrier: 'UPS', code: 'ups_10_kg_box',              label: 'UPS 10 kg Box',              dims: { l: 16.5,  w: 13.5,  h: 10.5  }                    },
  { carrier: 'UPS', code: 'ups_25_kg_box',              label: 'UPS 25 kg Box',              dims: { l: 19.5,  w: 17.5,  h: 13.5  }                    },
]

/** Generic (carrier-agnostic) packages — shown at top of dropdown outside any optgroup */
export const GENERIC_PACKAGES = SS_PACKAGES.filter(p => p.carrier === null)

/** Carrier-specific packages grouped by carrier */
export const CARRIERS = [...new Set(SS_PACKAGES.filter(p => p.carrier).map(p => p.carrier))]

/** Look up a catalog entry. carrier may be null for generic packages. */
export function findPackage(carrier, code) {
  const c = carrier === '' ? null : carrier
  return SS_PACKAGES.find(p => p.carrier === c && p.code === code) ?? null
}

/** Carrier-specific packages grouped for <optgroup> rendering */
export function packagesByCarrier() {
  return CARRIERS.map(carrier => ({
    carrier,
    packages: SS_PACKAGES.filter(p => p.carrier === carrier),
  }))
}

/** Catalog key used as <option> value: "carrier::code" or "::code" for generic */
export function catalogKey(pkg) {
  return `${pkg.carrier ?? ''}::${pkg.code}`
}
