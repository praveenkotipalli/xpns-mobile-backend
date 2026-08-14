-- Default categories, ported from com.expensys.model.enums.Category +
-- com.expensys.constant.CategoryMappings (sub -> main mapping) in the Spring Boot app.

INSERT INTO categories (space_id, key, label, main_category, icon, sort_order) VALUES
  (NULL, 'GROCERIES',                        'Groceries',                      'ESSENTIAL',     'cart',          10),
  (NULL, 'VEGETABLES_FRUITS_DAIRY_AND_MEAT', 'Vegetables, Fruits, Dairy & Meat','ESSENTIAL',    'nutrition',     20),
  (NULL, 'MEDICAL',                          'Medical',                        'ESSENTIAL',     'medkit',        30),
  (NULL, 'INVESTMENTS',                      'Investments',                    'ESSENTIAL',     'trending-up',   40),
  (NULL, 'OUTSIDE_FOOD',                     'Outside Food',                   'EXPENSE',       'fast-food',     50),
  (NULL, 'TRANSPORT',                        'Transport',                      'EXPENSE',       'bus',           60),
  (NULL, 'SHOPPING',                         'Shopping',                       'EXPENSE',       'bag-handle',    70),
  (NULL, 'SALON_AND_COSMETICS',              'Salon & Cosmetics',              'EXPENSE',       'cut',           80),
  (NULL, 'ENTERTAINMENT',                    'Entertainment',                  'EXPENSE',       'game-controller',90),
  (NULL, 'RENT_AND_OTHER_BILLS',             'Rent & Other Bills',             'EXPENSE',       'home',         100),
  (NULL, 'LOSE_OF_MONEY',                    'Lose of Money',                  'LOSE_OF_MONEY', 'alert-circle', 110),
  (NULL, 'OTHERS',                           'Others',                         'OTHERS',        'ellipsis-horizontal', 120)
ON CONFLICT DO NOTHING;
