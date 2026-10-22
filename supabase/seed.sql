-- Datos iniciales, copiados de los Excel de data/ (un escenario por archivo). Ejecutar después de schema.sql.
-- Se puede volver a ejecutar: reemplaza las tablas de datos (no toca log_ia).
-- Escenarios simulados para análisis académico; no son resultados reales.

truncate public.datos_crudos, public.diccionario, public.presupuesto, public.escenarios;

insert into public.escenarios (id, nombre, descripcion, orden) values
  ('base', 'Base', 'Datos del Excel publicado (data/kpis_marketing.xlsx).', 1),
  ('muy_favorable', 'Muy favorable', 'Escenario simulado con métricas muy por encima de lo esperado.', 2),
  ('neutro', 'Neutro', 'Escenario simulado con métricas en línea con lo esperado.', 3),
  ('desfavorable', 'Desfavorable', 'Escenario simulado con métricas por debajo de las metas.', 4);

insert into public.datos_crudos (escenario, semana, fecha_inicio, canal, inversion, impresiones, clics, conversiones, ingresos_atribuidos) values
  ('base', 39, '2026-09-21', 'Google Ads', 165000, 2250000, 88000, 22800, 544500),
  ('base', 39, '2026-09-21', 'Meta Ads', 128000, 2850000, 67500, 16900, 396800),
  ('base', 39, '2026-09-21', 'Yango Ads', 82000, 1380000, 37000, 12100, 270600),
  ('base', 40, '2026-09-28', 'Google Ads', 170000, 2300000, 91000, 23400, 561000),
  ('base', 40, '2026-09-28', 'Meta Ads', 130000, 2900000, 69000, 17200, 403000),
  ('base', 40, '2026-09-28', 'Yango Ads', 85000, 1420000, 38500, 12500, 280500),
  ('base', 41, '2026-10-05', 'Google Ads', 175000, 2350000, 93500, 24000, 595000),
  ('base', 41, '2026-10-05', 'Meta Ads', 135000, 2950000, 71000, 17600, 418500),
  ('base', 41, '2026-10-05', 'Yango Ads', 88000, 1480000, 40000, 12900, 299200),
  ('base', 42, '2026-10-12', 'Google Ads', 180000, 2400000, 96000, 26100, 612000),
  ('base', 42, '2026-10-12', 'Meta Ads', 142000, 3100000, 74000, 18900, 369200),
  ('base', 42, '2026-10-12', 'Yango Ads', 90000, 1500000, 41000, 13300, 297000),
  ('muy_favorable', 39, '2026-09-21', 'Google Ads', 165000, 2250000, 80719, 33825, 761062),
  ('muy_favorable', 39, '2026-09-21', 'Meta Ads', 128000, 2850000, 97256, 24960, 561600),
  ('muy_favorable', 39, '2026-09-21', 'Yango Ads', 82000, 1380000, 48300, 16400, 369000),
  ('muy_favorable', 40, '2026-09-28', 'Google Ads', 170000, 2300000, 82513, 34850, 784125),
  ('muy_favorable', 40, '2026-09-28', 'Meta Ads', 130000, 2900000, 98963, 25350, 570375),
  ('muy_favorable', 40, '2026-09-28', 'Yango Ads', 85000, 1420000, 49700, 17000, 382500),
  ('muy_favorable', 41, '2026-10-05', 'Google Ads', 175000, 2350000, 84306, 35875, 807187),
  ('muy_favorable', 41, '2026-10-05', 'Meta Ads', 135000, 2950000, 100669, 26325, 592312),
  ('muy_favorable', 41, '2026-10-05', 'Yango Ads', 88000, 1480000, 51800, 17600, 396000),
  ('muy_favorable', 42, '2026-10-12', 'Google Ads', 180000, 2400000, 86100, 36900, 830250),
  ('muy_favorable', 42, '2026-10-12', 'Meta Ads', 142000, 3100000, 105788, 27690, 623025),
  ('muy_favorable', 42, '2026-10-12', 'Yango Ads', 90000, 1500000, 52500, 18000, 405000),
  ('neutro', 39, '2026-09-21', 'Google Ads', 165000, 2250000, 57656, 21141, 507375),
  ('neutro', 39, '2026-09-21', 'Meta Ads', 128000, 2850000, 69469, 15600, 374400),
  ('neutro', 39, '2026-09-21', 'Yango Ads', 82000, 1380000, 34500, 10250, 246000),
  ('neutro', 40, '2026-09-28', 'Google Ads', 170000, 2300000, 58937, 21781, 522750),
  ('neutro', 40, '2026-09-28', 'Meta Ads', 130000, 2900000, 70688, 15844, 380250),
  ('neutro', 40, '2026-09-28', 'Yango Ads', 85000, 1420000, 35500, 10625, 255000),
  ('neutro', 41, '2026-10-05', 'Google Ads', 175000, 2350000, 60219, 22422, 538125),
  ('neutro', 41, '2026-10-05', 'Meta Ads', 135000, 2950000, 71906, 16453, 394875),
  ('neutro', 41, '2026-10-05', 'Yango Ads', 88000, 1480000, 37000, 11000, 264000),
  ('neutro', 42, '2026-10-12', 'Google Ads', 180000, 2400000, 61500, 23062, 553500),
  ('neutro', 42, '2026-10-12', 'Meta Ads', 142000, 3100000, 75562, 17306, 415350),
  ('neutro', 42, '2026-10-12', 'Yango Ads', 90000, 1500000, 37500, 11250, 270000),
  ('desfavorable', 39, '2026-09-21', 'Google Ads', 165000, 2250000, 34594, 9396, 253687),
  ('desfavorable', 39, '2026-09-21', 'Meta Ads', 128000, 2850000, 41681, 6933, 187200),
  ('desfavorable', 39, '2026-09-21', 'Yango Ads', 82000, 1380000, 20700, 4556, 123000),
  ('desfavorable', 40, '2026-09-28', 'Google Ads', 170000, 2300000, 35362, 9681, 261375),
  ('desfavorable', 40, '2026-09-28', 'Meta Ads', 130000, 2900000, 42412, 7042, 190125),
  ('desfavorable', 40, '2026-09-28', 'Yango Ads', 85000, 1420000, 21300, 4722, 127500),
  ('desfavorable', 41, '2026-10-05', 'Google Ads', 175000, 2350000, 36131, 9965, 269062),
  ('desfavorable', 41, '2026-10-05', 'Meta Ads', 135000, 2950000, 43144, 7312, 197438),
  ('desfavorable', 41, '2026-10-05', 'Yango Ads', 88000, 1480000, 22200, 4889, 132000),
  ('desfavorable', 42, '2026-10-12', 'Google Ads', 180000, 2400000, 36900, 10250, 276750),
  ('desfavorable', 42, '2026-10-12', 'Meta Ads', 142000, 3100000, 45338, 7692, 207675),
  ('desfavorable', 42, '2026-10-12', 'Yango Ads', 90000, 1500000, 22500, 5000, 135000);

insert into public.diccionario (kpi, definicion, formula, dueno, meta, orden) values
  ('ROAS', 'Retorno de la inversión publicitaria: ingresos atribuidos por cada dólar invertido.', 'Ingresos atribuidos ÷ inversión', 'Performance', '≥ 3,0x', 1),
  ('CPA', 'Costo por adquisición: cuánto cuesta cada conversión.', 'Inversión ÷ conversiones', 'Performance', '≤ $8', 2),
  ('Conversión', 'Pedido o viaje completado atribuido a una campaña.', 'Conteo de pedidos o viajes completados', 'Analista', '—', 3),
  ('CTR', 'Porcentaje de impresiones que generan un clic.', 'Clics ÷ impresiones', 'Performance', '≥ 2,5%', 4),
  ('Inversión', 'Gasto en medios pagado a la plataforma en la semana (USD, sin impuestos).', 'Suma del gasto reportado por la plataforma', 'Analista', 'Según presupuesto', 5),
  ('Ingresos atribuidos', 'Ingresos de los pedidos o viajes atribuidos a campañas según el modelo de la plataforma.', 'Suma de ingresos atribuidos', 'Analista', '—', 6);

insert into public.presupuesto (mes, canal, presupuesto) values
  ('2026-09', 'Google Ads', 720000),
  ('2026-09', 'Meta Ads', 560000),
  ('2026-09', 'Yango Ads', 350000),
  ('2026-10', 'Google Ads', 760000),
  ('2026-10', 'Meta Ads', 600000),
  ('2026-10', 'Yango Ads', 380000);
