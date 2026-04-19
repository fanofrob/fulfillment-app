/**
 * ShipStation carrier services catalog.
 * `carrierCode` is the exact ShipStation carrierCode for the API.
 * `code` is the exact ShipStation serviceCode for the API.
 * `shippingProviderId` (optional) — disambiguates accounts that share the same
 *   carrierCode. Sent as advancedOptions.billToMyOtherAccount on createorder.
 *   - se-4946429 = USPS by ShipStation (wallet, default when omitted)
 *   - se-5337414 = Stamps.com (own account, $20k+ balance)
 */

export const SS_SERVICES = [
  // ── USPS via ShipStation wallet (se-4946429) — default if no provider set ────
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_first_class_mail',                          label: 'First Class Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_priority_mail',                             label: 'Priority Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_priority_mail_express',                     label: 'Priority Mail Express' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_ground_advantage',                          label: 'Ground Advantage' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_parcel_select',                             label: 'Parcel Select Ground' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_media_mail',                                label: 'Media Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_library_mail',                              label: 'Library Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_first_class_package_international_service',  label: 'First Class Package International' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_priority_mail_international',               label: 'Priority Mail International' },
  { carrierCode: 'stamps_com', shippingProviderId: 4946429, carrierLabel: 'USPS — ShipStation', code: 'usps_priority_mail_express_international',       label: 'Priority Mail Express International' },

  // ── USPS via Stamps.com own account (se-5337414) ─────────────────────────────
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_first_class_mail',                          label: 'First Class Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_priority_mail',                             label: 'Priority Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_priority_mail_express',                     label: 'Priority Mail Express' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_ground_advantage',                          label: 'Ground Advantage' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_parcel_select',                             label: 'Parcel Select Ground' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_media_mail',                                label: 'Media Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_library_mail',                              label: 'Library Mail' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_first_class_package_international_service',  label: 'First Class Package International' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_priority_mail_international',               label: 'Priority Mail International' },
  { carrierCode: 'stamps_com', shippingProviderId: 5337414, carrierLabel: 'USPS — Stamps.com',  code: 'usps_priority_mail_express_international',       label: 'Priority Mail Express International' },

  // ── FedEx ────────────────────────────────────────────────────────────────────
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_ground',                                 label: 'FedEx Ground' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_home_delivery',                          label: 'FedEx Home Delivery' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_express_saver',                          label: 'FedEx Express Saver (3 Day)' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_2day',                                   label: 'FedEx 2Day' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_2day_am',                                label: 'FedEx 2Day A.M.' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_priority_overnight',                     label: 'FedEx Priority Overnight' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_standard_overnight',                     label: 'FedEx Standard Overnight' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_first_overnight',                        label: 'FedEx First Overnight' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_international_economy',                  label: 'FedEx International Economy' },
  { carrierCode: 'fedex',      carrierLabel: 'FedEx',  code: 'fedex_international_priority',                 label: 'FedEx International Priority' },

  // ── UPS ──────────────────────────────────────────────────────────────────────
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_ground',                                   label: 'UPS Ground' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_3_day_select',                             label: 'UPS 3 Day Select' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_2nd_day_air',                              label: 'UPS 2nd Day Air' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_2nd_day_air_am',                           label: 'UPS 2nd Day Air A.M.' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_next_day_air_saver',                       label: 'UPS Next Day Air Saver' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_next_day_air',                             label: 'UPS Next Day Air' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_next_day_air_early_am',                    label: 'UPS Next Day Air Early A.M.' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_standard',                                 label: 'UPS Standard' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_worldwide_expedited',                      label: 'UPS Worldwide Expedited' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_worldwide_saver',                          label: 'UPS Worldwide Saver' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_worldwide_express',                        label: 'UPS Worldwide Express' },
  { carrierCode: 'ups_walleted', carrierLabel: 'UPS',  code: 'ups_worldwide_express_plus',                   label: 'UPS Worldwide Express Plus' },

  // ── DHL Express ──────────────────────────────────────────────────────────────
  { carrierCode: 'dhl_express_worldwide', carrierLabel: 'DHL Express', code: 'dhl_express_worldwide',        label: 'DHL Express Worldwide' },
  { carrierCode: 'dhl_express_worldwide', carrierLabel: 'DHL Express', code: 'dhl_express_envelope',         label: 'DHL Express Envelope' },

  // ── Amazon Shipping ──────────────────────────────────────────────────────────
  { carrierCode: 'amazon_shipping_us', carrierLabel: 'Amazon Shipping', code: 'amazon_shipping_standard',    label: 'Amazon Shipping Standard' },
  { carrierCode: 'amazon_shipping_us', carrierLabel: 'Amazon Shipping', code: 'amazon_shipping_expedited',   label: 'Amazon Shipping Expedited' },
]

/**
 * Unique display groups in order — uses carrierLabel so USPS — ShipStation
 * and USPS — Stamps.com appear as separate optgroups.
 */
export const SERVICE_GROUPS = [...new Map(
  SS_SERVICES.map(s => [
    `${s.carrierCode}::${s.shippingProviderId ?? ''}`,
    { carrierCode: s.carrierCode, shippingProviderId: s.shippingProviderId ?? null, carrierLabel: s.carrierLabel },
  ])
).values()]

/** Services grouped by carrierLabel for <optgroup> rendering */
export function servicesByCarrier() {
  return SERVICE_GROUPS.map(({ carrierCode, shippingProviderId, carrierLabel }) => ({
    carrierCode,
    shippingProviderId,
    carrierLabel,
    services: SS_SERVICES.filter(s =>
      s.carrierCode === carrierCode &&
      (s.shippingProviderId ?? null) === shippingProviderId
    ),
  }))
}

/**
 * Look up a single service entry by carrierCode + serviceCode + optional providerId.
 * Falls back to first match on carrierCode+serviceCode for backward compat.
 */
export function findService(carrierCode, serviceCode, shippingProviderId = null) {
  return (
    SS_SERVICES.find(s =>
      s.carrierCode === carrierCode &&
      s.code === serviceCode &&
      (s.shippingProviderId ?? null) === shippingProviderId
    ) ??
    SS_SERVICES.find(s => s.carrierCode === carrierCode && s.code === serviceCode) ??
    null
  )
}

/**
 * Catalog key used as <option> value.
 * Format: "carrierCode::providerId::serviceCode" — providerId is empty string when absent.
 */
export function serviceKey(svc) {
  return `${svc.carrierCode}::${svc.shippingProviderId ?? ''}::${svc.code}`
}

/** Parse a serviceKey back into its parts */
export function parseServiceKey(key) {
  if (!key) return { carrierCode: '', shippingProviderId: null, serviceCode: '' }
  const [carrierCode, providerPart, serviceCode] = key.split('::')
  return {
    carrierCode,
    shippingProviderId: providerPart ? parseInt(providerPart, 10) : null,
    serviceCode,
  }
}
